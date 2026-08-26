import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session.js'

/**
 * Ce qui se règle une fois, et vaut pour toute la journée.
 *
 * Six panneaux dans une seule vue, et un seul store : ils partagent tous
 * `settings/update`, et c'est le hub qui tranche ce qu'il retient. Le store ne
 * déduit rien — il repose ce que le hub a répondu.
 */
export interface Settings {
  eventName?: string | null
  eventShortName?: string | null
  openFeedbackProjectId?: string | null
  programSourceUrl?: string | null
  autoEndEnabled: boolean
  autoEndGraceMinutes: number
  socialLinks: SocialLink[]
  vodBucket?: string | null
  vodPrefix?: string | null
}

export interface SocialLink {
  network: string
  handle: string
  url: string
}

export interface Snapshot {
  contentHash: string
  sessionCount: number
  issueCount: number
  active: boolean
}

/** Ce que le hub déduirait du programme importé, réglages ignorés. */
export interface DerivedIdentity {
  name: string
  shortName: string
}

export interface StoragePolicy {
  actif: boolean
  debitMaxOctetsS?: number | null
  cpuMax: number
  margeConferenceMinutes: number
  taillePartMo: number
}

export interface StorageStatus {
  endpoint?: string | null
  bucket?: string | null
  prefix?: string | null
  configure: boolean
  politique: StoragePolicy
}

export interface StorageCheck {
  ok: boolean
  etapes: { nom: string; ok: boolean; detail?: string | null }[]
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Settings | null>(null)
  const derived = ref<DerivedIdentity>({ name: '', shortName: '' })
  const snapshots = ref<Snapshot[]>([])
  const rooms = ref<{ id: string; name: string }[]>([])
  const storage = ref<StorageStatus | null>(null)

  const session = useSessionStore()

  async function load(): Promise<void> {
    const [reglages, identite, instantanes, salles, stockage] = await Promise.all([
      session.client.rpc.settings.get(),
      session.client.rpc.event.identity(),
      session.client.rpc.program.snapshots(),
      session.client.rpc.rooms.list(),
      session.client.rpc.vod.status(),
    ])
    settings.value = reglages as Settings
    const identity = identite as { derived?: DerivedIdentity }
    if (identity.derived != null) derived.value = identity.derived
    snapshots.value = instantanes as Snapshot[]
    rooms.value = salles as { id: string; name: string }[]
    storage.value = stockage as StorageStatus
  }

  /**
   * Enregistre, puis repose ce que le hub a répondu.
   *
   * Et non ce que la page aurait déduit à sa place : c'est lui qui tranche, et
   * l'écart entre les deux est précisément ce qu'un opérateur vient vérifier
   * après avoir enregistré.
   */
  async function update(patch: Record<string, unknown>): Promise<void> {
    settings.value = (await session.client.rpc.settings.update(patch)) as Settings
    await load()
  }

  async function activate(contentHash: string): Promise<void> {
    await session.client.rpc.program.activate({ contentHash })
    await load()
  }

  /**
   * Réimporte depuis l'URL **enregistrée**, jamais depuis celle qui est à l'écran.
   *
   * C'est ce que le hub lira de toute façon : partir d'une autre ferait croire
   * qu'on a importé ce qu'on venait de taper.
   */
  async function reimport(): Promise<number> {
    const url = settings.value?.programSourceUrl
    if (url == null || url === '') throw new Error('Aucune URL de programme enregistrée')
    const resultat = (await session.client.rpc.program.import({ sourceUrl: url })) as {
      program: { sessions: unknown[] }
    }
    await load()
    return resultat.program.sessions.length
  }

  async function resync(roomId: string | null): Promise<{ rooms: number }> {
    return (await session.client.rpc.rooms.resync({ roomId })) as { rooms: number }
  }

  async function checkStorage(): Promise<StorageCheck> {
    return (await session.client.rpc.vod.check()) as StorageCheck
  }

  return {
    settings,
    derived,
    snapshots,
    rooms,
    storage,
    load,
    update,
    activate,
    reimport,
    resync,
    checkStorage,
  }
})

/** Vidé = revenir à la déduction. Distinguer « vide » d'« absent » est tout l'intérêt. */
export function orNull(value: string): string | null {
  return value.trim() === '' ? null : value.trim()
}

/** Ce que dit chaque étape du contrôle de stockage. */
export const STORAGE_STEPS: Record<string, string> = {
  joindre: 'Joindre le stockage',
  authentifier: 'Clés et bucket',
  signer: 'Adresse signée',
  nettoyer: 'Nettoyage',
}
