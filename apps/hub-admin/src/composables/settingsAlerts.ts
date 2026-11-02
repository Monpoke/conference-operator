import type { ReglagesSection } from '@conference-operator/contract'
import { deliveryStatus, type Integration } from '../stores/integrations.js'
import type { RoomStream, StorageStatus } from '../stores/settings.js'

/**
 * What needs doing, section by section.
 *
 * Only what is broken or half done: a room with neither server nor key simply does
 * not stream, and a hub with no S3 keys cannot fix that from here. A menu that
 * always shows a badge soon stops being read.
 */
export function settingsAlerts(state: {
  loaded: boolean
  failedImages: number
  streams: RoomStream[]
  urgentPinSet: boolean
  wallsIoError: string | null
  storage: StorageStatus | null
  integrations: Integration[]
}): Record<ReglagesSection, string[]> {
  const alerts: Record<ReglagesSection, string[]> = { evenement: [], salles: [], public: [], video: [], systeme: [] }
  // Before the first answer, everything would read as missing.
  if (!state.loaded) return alerts

  if (state.failedImages > 0) alerts.evenement.push(`${state.failedImages} image(s) du programme manquante(s)`)
  for (const item of state.streams) {
    if ((item.rtmpUrl !== '') !== item.hasKey) alerts.salles.push(`Diffusion incomplète : ${item.name}`)
  }
  if (!state.urgentPinSet) alerts.salles.push('Aucun code PIN : les messages urgents sont refusés')
  if (state.wallsIoError != null) alerts.public.push(`walls.io : ${state.wallsIoError}`)
  if (state.storage?.endpoint != null && !state.storage.configure) alerts.video.push('Stockage : aucun bucket')
  for (const item of state.integrations) {
    if (item.enabled && deliveryStatus(item)?.ok === false) alerts.systeme.push(`Intégration en échec : ${item.name}`)
  }
  return alerts
}
