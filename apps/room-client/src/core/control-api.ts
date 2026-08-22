import { z } from 'zod'
import { displayModeSchema, obsInstanceSchema, roomConfigPatchSchema, sceneRoleSchema } from '@cloudnord/contract'
import type { ModeExecution, ObsInstance, RoomConfigPatch, SceneRoleMap } from '@cloudnord/contract'
import type { ObsState } from './obs.js'
import type { StopResult } from './recording.js'

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
  z.object({ action: z.literal('recording.mark'), label: z.string().min(1).max(80) }),
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
  mark(label: string): void
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
  diagnostics(): ControlDiagnostics
}

/**
 * Configuration de la salle telle que la régie la voit.
 *
 * Les mots de passe OBS n'en font pas partie : seulement le fait qu'il y en a
 * un. Le formulaire n'a pas besoin de les relire pour les garder — un champ
 * laissé vide vaut « inchangé » — et une page servie en HTTP n'est pas
 * l'endroit où faire réapparaître un secret déjà enregistré.
 */
export interface ConfigVisible {
  obs: { A: PointObsVisible; B: PointObsVisible }
  sceneRoles: SceneRoleMap
  displayPort: number
  recordingRoot: string | null
  fileSlug: string | null
  relaySourceRoomId: string | null
  /** Projet OpenFeedback, pour le QR « Notez le talk ». */
  openFeedbackProjectId: string | null
}

export interface PointObsVisible {
  url: string
  hasPassword: boolean
  /**
   * La connexion en cours n'a pas été ouverte avec ces réglages-là.
   *
   * Enregistrer ne reconnecte pas : c'est à l'opérateur de choisir quand
   * couper une instance. Encore faut-il qu'il voie qu'il reste à le faire.
   */
  pending: boolean
}

export interface ControlDiagnostics {
  obs: { A: ObsState | null; B: ObsState | null }
  /**
   * Questions posées dans cette salle, les plus votées d'abord.
   *
   * Relues à la demande plutôt que poussées : la régie ne les regarde qu'en
   * fin de talk, et les faire circuler en continu chargerait le flux d'état
   * pour rien.
   */
  questions: { id: string; text: string; author: string | null; votes: number }[]
  /** Instant de la dernière relecture, pour dire une liste datée. */
  questionsRefreshedAt: string | null
  /**
   * Conférence à laquelle se rapportent les questions listées.
   *
   * Affiché en régie : une liste vide ne dit pas la même chose selon qu'aucune
   * question n'a été posée sur ce talk, ou qu'aucun talk n'est piloté. `null`
   * dans le second cas.
   */
  questionsSession: { id: string; title: string } | null
  /** Réglages de la salle, pour le panneau de configuration. `null` avant le premier sync. */
  config: ConfigVisible | null
  /**
   * Modes d'exécution, celui de la salle et celui du hub.
   *
   * `hub` reste `null` tant qu'aucune synchronisation n'a abouti. Les deux sont
   * affichés ensemble parce que c'est leur **désaccord** qui compte : une salle
   * de développement branchée sur le hub de l'événement enverrait de vraies
   * commandes depuis un poste qui simule tout.
   */
  mode: { salle: ModeExecution; hub: ModeExecution | null }
  /** Salle relayée, `null` si le relais n'est pas configuré pour cette salle. */
  relaySourceRoomId: string | null
  /**
   * État des autres salles, tel que le hub le connaît.
   *
   * Rafraîchi périodiquement et **mis en cache** : l'opérateur doit pouvoir
   * jeter un œil aux autres salles sans que chaque rendu d'écran déclenche un
   * appel réseau.
   */
  rooms: {
    roomId: string
    name: string
    connectivity: string
    sceneRole: string | null
    recording: boolean
    outboxDepth: number
    lastSeenAt: string | null
  }[]
  /** Instant du dernier rafraîchissement des salles, pour signaler une vue périmée. */
  roomsRefreshedAt: string | null
  outboxDepth: number
  journal: { level: string; message: string; createdAt: string }[]
  /** Enregistrement en cours côté client, et nombre de marqueurs posés. */
  recording: { active: boolean; markers: number; startedAtMs: number | null }
}

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
        target.mark(action.label)
        return { ok: true, message: `Marqueur « ${action.label} »` }
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
