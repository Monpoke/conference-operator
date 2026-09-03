import { z } from 'zod'
import { displayModeSchema, obsInstanceSchema, roomConfigPatchSchema, sceneRoleSchema } from '@cloudnord/contract'
import type {
  VisibleConfig,
  VodList,
  ControlDiagnostics,
  MarkerRole,
  ExecutionMode,
  ObsInstance,
  VisibleObsEndpoint,
  RoomConfigPatch,
  SceneRoleMap,
} from '@cloudnord/contract'
import type { ObsState } from './obs.js'
import type { StopResult } from './recording.js'
import type { VodCheck, VodEntry, Extrait, FluxFichier, VodVerdict } from './vod-index.js'
import type { UploadsView } from './upload.js'

/**
 * Actions que la fenêtre de régie peut déclencher.
 *
 * Décrit comme un contrat à part entière — et non comme un accès direct à
 * `RoomApp` — pour que la page ne puisse appeler que ce qui est prévu, et que
 * chaque entrée soit validée avant d'atteindre OBS.
 */
export const controlActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('display.set'), mode: displayModeSchema }),
  z.object({ action: z.literal('scene.set'), role: sceneRoleSchema }),
  z.object({ action: z.literal('recording.start') }),
  z.object({ action: z.literal('recording.stop') }),
  /**
   * Marqueur posé pendant la prise.
   *
   * `role` nul : un chapitre, qu'on empile autant qu'on veut. `debut` et `fin`
   * sont les deux **repères de editing**, et le poste n'en garde qu'un de
   * chaque — les reposer corrige, ce qui est exactement le geste qu'on fait
   * quand l'orateur a eu un faux départ. Le libellé reste libre : c'est lui
   * qu'on relit dans le journal.
   */
  z.object({
    action: z.literal('recording.mark'),
    label: z.string().min(1).max(80),
    role: z.enum(['debut', 'fin']).nullable().default(null),
  }),
  /**
   * Contrôle des rushes déjà produits.
   *
   * Séparé de la captation elle-même : `vod.inspect` ne touche pas à OBS, il
   * relit un fichier sur le disque. On peut donc vérifier la matinée pendant
   * que l'après-midi enregistre — ce qui est tout l'intérêt, la salle étant
   * démontée bien avant que quiconque ouvre les fichiers.
   */
  z.object({ action: z.literal('vod.inspect'), file: z.string().min(1).max(400) }),
  /** Dernier mot de l'opérateur, qui a pu ouvrir le fichier. `null` efface. */
  z.object({
    action: z.literal('vod.verdict'),
    file: z.string().min(1).max(400),
    status: z.enum(['ok', 'suspect', 'illisible']).nullable(),
  }),
  /**
   * Rapatriement d'un rush vers le stockage du hub.
   *
   * Séparé de `vod.inspect` comme celui-ci l'est de la captation : rien ici ne
   * touche à OBS. La demande passe par le régulateur, qui peut la reporter —
   * mais une demande **manuelle** passe outre l'attente ordinaire : celui qui
   * appuie a la salle sous les yeux. `file` nul vise tout ce qui reste.
   */
  z.object({ action: z.literal('vod.upload'), file: z.string().max(400).nullable().default(null) }),
  /** Renonce à un téléversement en cours. Le hub ferme le multipart. */
  z.object({ action: z.literal('vod.upload.cancel'), file: z.string().min(1).max(400) }),
  z.object({ action: z.literal('stream.start') }),
  z.object({ action: z.literal('stream.stop') }),
  z.object({ action: z.literal('hub.sync') }),
  /** Cycle de vie de la conférence en cours. */
  z.object({ action: z.literal('session.start') }),
  z.object({ action: z.literal('session.end') }),
  z.object({ action: z.literal('session.reset') }),
  /** Choix de la salle desservie, depuis l'écran d'appairage. */
  z.object({ action: z.literal('pairing.chooseRoom'), roomId: z.string().min(1) }),
  /**
   * Bandeau des scènes live, posé depuis la régie.
   *
   * La salle pilote ses propres surfaces — c'est déjà le cas de son écran —
   * et le hub garde la sienne : les deux écrivent le même état. `text` nul
   * retire le bandeau.
   */
  z.object({
    action: z.literal('overlay.set'),
    text: z.string().min(1).max(240).nullable(),
    level: z.enum(['info', 'warning', 'urgent']).default('info'),
  }),
  /**
   * Question du public mise à l'antenne.
   *
   * Canal distinct de `overlay.set`, et non un bandeau de plus : la question va
   * dans l'habillage de captation — donc dans la VOD —, le bandeau non. Les
   * confondre revenait à ne pouvoir montrer ni l'un ni l'autre sans l'autre.
   * `text` nul la retire.
   */
  z.object({
    action: z.literal('question.set'),
    text: z.string().min(1).max(300).nullable(),
    author: z.string().max(80).nullable().default(null),
  }),
  /** Relit les questions posées dans cette salle. */
  z.object({ action: z.literal('questions.refresh') }),
  /** Écarte un signalement lu. */
  z.object({ action: z.literal('notification.dismiss'), id: z.string().min(1) }),
  /**
   * Réglage de la salle depuis la régie.
   *
   * Part au hub, qui reste la source de vérité : le garder en local serait
   * écrasé au prochain sync. La salle se resynchronise puis rouvre ses
   * connexions OBS avec les nouveaux paramètres.
   */
  z.object({ action: z.literal('room.configure'), patch: roomConfigPatchSchema }),
  /** Relit les scènes déclarées dans OBS, sans rien reconnecter. */
  z.object({ action: z.literal('obs.refreshScenes') }),
  /**
   * Ouvre le sélecteur de dossier du poste, pour le chemin des rushes.
   *
   * Le geste vit ici et non dans la page : un chemin de disque se saisit à la
   * main sans erreur seulement quand on l'a sous les yeux, et c'est justement
   * la machine de salle qu'il désigne — pas celle d'où l'on regarde. Le poste
   * répond le chemin choisi, ou rien si l'opérateur a renoncé.
   *
   * Ne **modifie pas** la configuration : le champ se remplit, et c'est
   * « Enregistrer » qui décide, comme pour tout le reste du panneau.
   */
  z.object({ action: z.literal('config.chooseFolder') }),
  /**
   * Ouvre (ou rouvre) **une** instance OBS.
   *
   * Instance par instance, et jamais les deux ensemble : couper la captation
   * pour appliquer un réglage de projection coûterait une VOD.
   */
  z.object({ action: z.literal('obs.connect'), instance: obsInstanceSchema }),
  /** Message de la salle vers la console. */
  z.object({
    action: z.literal('message.send'),
    text: z.string().min(1).max(500),
    level: z.enum(['info', 'warning', 'urgent']),
  }),
])
export type ControlAction = z.infer<typeof controlActionSchema>

/** Ce que la régie doit implémenter. `RoomApp` s'y conforme. */
export interface ControlTarget {
  setDisplayMode(mode: z.infer<typeof displayModeSchema>): Promise<void>
  setSceneRole(role: z.infer<typeof sceneRoleSchema>): Promise<void>
  startRecording(): Promise<void>
  stopRecording(): Promise<StopResult>
  /** `role` nul = chapitre ; `debut`/`fin` = repère de editing, unique et remplaçable. */
  mark(label: string, role: MarkerRole | null): void
  /** Rushes produits sous la racine d'enregistrement, et leur dernier contrôle. */
  listRecordings(): Promise<VodList>
  inspectRecording(file: string): Promise<VodCheck>
  setRecordingVerdict(file: string, status: VodVerdict | null): Promise<VodCheck | null>
  /** Téléversements en cours et raison d'attente, pour la modale des rushes. */
  vodUploads(): UploadsView
  /** Met un rush en file. `file` nul = tout ce qui reste. Rend le nombre visé. */
  uploadRecording(file: string | null): Promise<number>
  cancelUpload(file: string): Promise<void>
  /** Extrait lisible dans le navigateur. `null` : ffmpeg absent de la machine. */
  readRecordingExtract(file: string, atMs: number, dureeMs: number): Promise<Extrait | null>
  /** Le rush tel quel, par tranche. `null` : fichier absent. */
  readRecordingFile(file: string, plage: string | null): Promise<FluxFichier | null>
  startStreaming(): Promise<void>
  stopStreaming(): Promise<void>
  resync(): Promise<void>
  startSession(): Promise<void>
  endSession(): Promise<void>
  resetSession(): Promise<void>
  chooseRoom(roomId: string): Promise<void>
  dismissNotification(id: string): void
  sendMessage(text: string, level: 'info' | 'warning' | 'urgent'): void
  setLiveMessage(text: string | null, level: 'info' | 'warning' | 'urgent'): void
  setAiredQuestion(text: string | null, author: string | null): void
  refreshQuestions(): Promise<void>
  configureRoom(patch: RoomConfigPatch): Promise<void>
  connectObsInstance(instance: ObsInstance): Promise<void>
  refreshObsScenes(): Promise<void>
  /** Chemin choisi, ou `null` si l'opérateur a renoncé ou si le poste ne sait pas. */
  chooseFolder(): Promise<string | null>
  diagnostics(): ControlDiagnostics
}

export type { VisibleConfig, ControlDiagnostics, VisibleObsEndpoint }

export type { VodList }

export interface ControlOutcome {
  ok: boolean
  message?: string
  detail?: unknown
}

/**
 * Exécute une action de régie.
 *
 * Ne laisse jamais fuiter une exception : un échec doit revenir à l'opérateur
 * sous forme de message lisible dans l'interface, pas d'une page cassée au
 * milieu d'une intervention.
 */
export async function runControlAction(
  target: ControlTarget,
  action: ControlAction,
): Promise<ControlOutcome> {
  try {
    switch (action.action) {
      case 'display.set':
        await target.setDisplayMode(action.mode)
        return { ok: true, message: `Écran : ${action.mode}` }
      case 'scene.set':
        await target.setSceneRole(action.role)
        return { ok: true, message: `Scène : ${action.role}` }
      case 'recording.start':
        await target.startRecording()
        return { ok: true, message: 'Enregistrement démarré' }
      case 'recording.stop': {
        const result = await target.stopRecording()
        return {
          ok: true,
          message:
            result.sidecarPath == null
              ? 'Enregistrement arrêté — sidecar non écrit, vérifier OBS'
              : `Enregistrement arrêté — ${result.sidecar.videoFile}`,
          detail: { videoPath: result.videoPath, sidecarPath: result.sidecarPath },
        }
      }
      case 'recording.mark':
        target.mark(action.label, action.role)
        /*
         * Deux phrases, parce que ce sont deux gestes.
         *
         * « Marqueur « Début » » ne dirait pas que le repère précédent vient
         * d'être effacé — et c'est précisément ce qu'on veut lire quand on
         * repose le début après un faux départ.
         */
        return {
          ok: true,
          message:
            action.role == null
              ? `Marqueur « ${action.label} »`
              : `Repère de ${action.role === 'debut' ? 'début' : 'fin'} posé`,
        }
      case 'vod.inspect': {
        const controle = await target.inspectRecording(action.file)
        return {
          ok: true,
          message:
            controle.status === 'ok'
              ? `${action.file} — exploitable`
              : `${action.file} — ${controle.status} : ${controle.reasons[0] ?? ''}`,
          detail: controle,
        }
      }
      case 'vod.verdict': {
        const controle = await target.setRecordingVerdict(action.file, action.status)
        return {
          ok: true,
          message: action.status == null ? 'Contrôle effacé' : `${action.file} — ${action.status}`,
          detail: controle,
        }
      }
      case 'vod.upload': {
        const vises = await target.uploadRecording(action.file)
        return {
          ok: true,
          message:
            vises === 0
              ? 'Rien à téléverser'
              : vises === 1
                ? 'Téléversement demandé'
                : `${vises} fichiers en file`,
        }
      }
      case 'vod.upload.cancel':
        await target.cancelUpload(action.file)
        return { ok: true, message: 'Téléversement annulé' }
      case 'stream.start':
        await target.startStreaming()
        return { ok: true, message: 'Diffusion démarrée' }
      case 'stream.stop':
        await target.stopStreaming()
        return { ok: true, message: 'Diffusion arrêtée' }
      case 'hub.sync':
        await target.resync()
        return { ok: true, message: 'Synchronisation demandée' }
      case 'session.start':
        await target.startSession()
        return { ok: true, message: 'Conférence démarrée' }
      case 'session.end':
        await target.endSession()
        return { ok: true, message: 'Conférence terminée' }
      case 'session.reset':
        await target.resetSession()
        return { ok: true, message: 'Conférence remise à « à venir »' }
      case 'pairing.chooseRoom':
        await target.chooseRoom(action.roomId)
        return { ok: true, message: 'Demande d\'appairage envoyée' }
      case 'notification.dismiss':
        target.dismissNotification(action.id)
        return { ok: true }
      case 'message.send':
        target.sendMessage(action.text, action.level)
        return { ok: true, message: 'Message envoyé à la console' }
      case 'room.configure':
        await target.configureRoom(action.patch)
        return { ok: true, message: 'Configuration enregistrée' }
      case 'config.chooseFolder': {
        const dossier = await target.chooseFolder()
        // Renoncer n'est pas un échec : fermer un sélecteur est un geste, pas
        // une panne, et un rouge à ce moment-là se lit comme un refus du poste.
        return { ok: true, detail: dossier, message: dossier ?? 'Aucun dossier choisi' }
      }
      case 'obs.refreshScenes':
        await target.refreshObsScenes()
        return { ok: true, message: 'Scènes relues dans OBS' }
      case 'overlay.set':
        target.setLiveMessage(action.text, action.level)
        return { ok: true, message: action.text == null ? 'Bandeau retiré' : 'Bandeau affiché' }
      case 'question.set':
        target.setAiredQuestion(action.text, action.author)
        return { ok: true, message: action.text == null ? 'Question retirée' : 'Question à l\u2019antenne' }
      case 'questions.refresh':
        await target.refreshQuestions()
        return { ok: true, message: 'Questions relues' }
      case 'obs.connect':
        await target.connectObsInstance(action.instance)
        return { ok: true, message: 'OBS-' + action.instance + ' connecté' }
    }
  } catch (cause) {
    return { ok: false, message: (cause as Error).message }
  }
}
