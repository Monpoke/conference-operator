import { z } from 'zod'
import { displayModeSchema, obsInstanceSchema, roomConfigPatchSchema, sceneRoleSchema } from '@conference-operator/contract'
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
} from '@conference-operator/contract'
import type { ObsState } from './obs.js'
import type { StopResult } from './recording.js'
import type { VodCheck, VodEntry, Excerpt, FileStream, VodVerdict } from './vod-index.js'
import type { UploadsView } from './upload.js'

/**
 * The actions the control window can trigger.
 *
 * Described as a contract in its own right — and not as direct access to
 * `RoomApp` — so that the page can only call what is intended, and so that every
 * input is validated before reaching OBS.
 *
 * The action names and the enum values (`debut`, `fin`, `ok`, `suspect`,
 * `illisible`) are contract values: they do not get renamed.
 */
export const controlActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('display.set'), mode: displayModeSchema }),
  z.object({ action: z.literal('scene.set'), role: sceneRoleSchema }),
  z.object({ action: z.literal('recording.start') }),
  z.object({ action: z.literal('recording.stop') }),
  /**
   * A marker placed during the take.
   *
   * A null `role`: a chapter, which can be stacked as much as one likes. `debut`
   * and `fin` are the two **editing markers**, and the machine keeps only one of
   * each — placing them again corrects, which is exactly the gesture one makes
   * when the speaker had a false start. The label stays free: it is what one reads
   * back in the log.
   */
  z.object({
    action: z.literal('recording.mark'),
    label: z.string().min(1).max(80),
    role: z.enum(['debut', 'fin']).nullable().default(null),
  }),
  /**
   * Checking the rushes already produced.
   *
   * Separate from the capture itself: `vod.inspect` does not touch OBS, it reads
   * back a file on disk. One can therefore check the morning while the afternoon
   * records — which is the whole point, the room being dismantled long before
   * anyone opens the files.
   */
  z.object({ action: z.literal('vod.inspect'), file: z.string().min(1).max(400) }),
  /** The operator's last word, having been able to open the file. `null` clears it. */
  z.object({
    action: z.literal('vod.verdict'),
    file: z.string().min(1).max(400),
    status: z.enum(['ok', 'suspect', 'illisible']).nullable(),
  }),
  /**
   * Shipping a rush back to the hub's storage.
   *
   * Separate from `vod.inspect` as that one is from the capture: nothing here
   * touches OBS. The request goes through the regulator, which can defer it — but
   * a **manual** request overrides the ordinary wait: whoever presses has the room
   * in front of them. A null `file` targets everything that is left.
   */
  z.object({ action: z.literal('vod.upload'), file: z.string().max(400).nullable().default(null) }),
  /** Gives up an upload in progress. The hub closes the multipart. */
  z.object({ action: z.literal('vod.upload.cancel'), file: z.string().min(1).max(400) }),
  z.object({ action: z.literal('stream.start') }),
  z.object({ action: z.literal('stream.stop') }),
  z.object({ action: z.literal('hub.sync') }),
  /** The running talk's lifecycle. */
  z.object({ action: z.literal('session.start') }),
  z.object({ action: z.literal('session.end') }),
  z.object({ action: z.literal('session.reset') }),
  /** Choosing the room served, from the pairing screen. */
  z.object({ action: z.literal('pairing.chooseRoom'), roomId: z.string().min(1) }),
  /**
   * The live scenes' banner, set from the control app.
   *
   * The room drives its own surfaces — that is already the case for its screen —
   * and the hub keeps its own: both write the same state. A null `text` removes
   * the banner.
   */
  z.object({
    action: z.literal('overlay.set'),
    text: z.string().min(1).max(240).nullable(),
    level: z.enum(['info', 'warning', 'urgent']).default('info'),
  }),
  /**
   * An audience question put on air.
   *
   * A channel distinct from `overlay.set`, and not one more banner: the question
   * goes into the capture overlay — and therefore into the VOD — the banner does
   * not. Confusing them meant being unable to show either without the other. A
   * null `text` removes it.
   */
  z.object({
    action: z.literal('question.set'),
    text: z.string().min(1).max(300).nullable(),
    author: z.string().max(80).nullable().default(null),
  }),
  /** Reads back the questions asked in this room. */
  z.object({ action: z.literal('questions.refresh') }),
  /** Dismisses a notice that has been read. */
  z.object({ action: z.literal('notification.dismiss'), id: z.string().min(1) }),
  /**
   * Setting the room up from the control app.
   *
   * Goes to the hub, which stays the source of truth: keeping it locally would get
   * it overwritten at the next sync. The room resynchronizes then reopens its OBS
   * connections with the new parameters.
   */
  z.object({ action: z.literal('room.configure'), patch: roomConfigPatchSchema }),
  /** Reads back the scenes declared in OBS, reconnecting nothing. */
  z.object({ action: z.literal('obs.refreshScenes') }),
  /**
   * Opens the machine's folder picker, for the rushes' path.
   *
   * The gesture lives here and not in the page: a disk path is typed by hand
   * without error only when one has it in front of one, and it is precisely the
   * room machine it designates — not the one it is being watched from. The machine
   * answers with the chosen path, or nothing if the operator gave up.
   *
   * Does **not** change the configuration: the field gets filled in, and it is
   * "Enregistrer" that decides, as for all the rest of the panel.
   */
  z.object({ action: z.literal('config.chooseFolder') }),
  /**
   * Opens (or reopens) **one** OBS instance.
   *
   * Instance by instance, and never both together: cutting the capture to apply a
   * projection setting would cost a VOD.
   */
  z.object({ action: z.literal('obs.connect'), instance: obsInstanceSchema }),
  /** A message from the room to the console. */
  z.object({
    action: z.literal('message.send'),
    text: z.string().min(1).max(500),
    level: z.enum(['info', 'warning', 'urgent']),
  }),
])
export type ControlAction = z.infer<typeof controlActionSchema>

/** What the control app has to implement. `RoomApp` conforms to it. */
export interface ControlTarget {
  setDisplayMode(mode: z.infer<typeof displayModeSchema>): Promise<void>
  setSceneRole(role: z.infer<typeof sceneRoleSchema>): Promise<void>
  startRecording(): Promise<void>
  stopRecording(): Promise<StopResult>
  /** A null `role` = a chapter; `debut`/`fin` = an editing marker, unique and replaceable. */
  mark(label: string, role: MarkerRole | null): void
  /** The rushes produced under the recording root, and their last check. */
  listRecordings(): Promise<VodList>
  inspectRecording(file: string): Promise<VodCheck>
  setRecordingVerdict(file: string, status: VodVerdict | null): Promise<VodCheck | null>
  /** The uploads in progress and the reason for waiting, for the rushes modal. */
  vodUploads(): UploadsView
  /** Queues a rush. A null `file` = everything left. Returns the number targeted. */
  uploadRecording(file: string | null): Promise<number>
  cancelUpload(file: string): Promise<void>
  /** An excerpt playable in the browser. `null`: ffmpeg absent from the machine. */
  readRecordingExtract(file: string, atMs: number, durationMs: number): Promise<Excerpt | null>
  /** The rush as it is, by range. `null`: the file is absent. */
  readRecordingFile(file: string, plage: string | null): Promise<FileStream | null>
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
  /** The chosen path, or `null` if the operator gave up or the machine cannot ask. */
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
 * Runs a control action.
 *
 * Never lets an exception escape: a failure must come back to the operator as a
 * readable message in the interface, not as a broken page in the middle of an
 * intervention.
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
         * Two sentences, because they are two gestures.
         *
         * "Marqueur « Début »" would not say that the previous marker has just been
         * erased — and that is precisely what one wants to read when placing the
         * start again after a false start.
         */
        return {
          ok: true,
          message:
            action.role == null
              ? `Marqueur « ${action.label} »`
              : `Repère de ${action.role === 'debut' ? 'début' : 'fin'} posé`,
        }
      case 'vod.inspect': {
        const check = await target.inspectRecording(action.file)
        return {
          ok: true,
          message:
            check.status === 'ok'
              ? `${action.file} — exploitable`
              : `${action.file} — ${check.status} : ${check.reasons[0] ?? ''}`,
          detail: check,
        }
      }
      case 'vod.verdict': {
        const check = await target.setRecordingVerdict(action.file, action.status)
        return {
          ok: true,
          message: action.status == null ? 'Contrôle effacé' : `${action.file} — ${action.status}`,
          detail: check,
        }
      }
      case 'vod.upload': {
        const targeted = await target.uploadRecording(action.file)
        return {
          ok: true,
          message:
            targeted === 0
              ? 'Rien à téléverser'
              : targeted === 1
                ? 'Téléversement demandé'
                : `${targeted} fichiers en file`,
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
        const folder = await target.chooseFolder()
        // Giving up is not a failure: closing a picker is a gesture, not a
        // breakdown, and a red at that moment reads as a refusal from the machine.
        return { ok: true, detail: folder, message: folder ?? 'Aucun dossier choisi' }
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
