import { z } from 'zod'
import { displayModeSchema, sceneRoleSchema } from '@cloudnord/contract'
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
  /** Écarte un signalement lu. */
  z.object({ action: z.literal('notification.dismiss'), id: z.string().min(1) }),
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
  diagnostics(): ControlDiagnostics
}

export interface ControlDiagnostics {
  obs: { A: ObsState | null; B: ObsState | null }
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
    }
  } catch (cause) {
    return { ok: false, message: (cause as Error).message }
  }
}
