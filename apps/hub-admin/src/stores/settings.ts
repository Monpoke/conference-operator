import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session.js'

/**
 * What is set once, and holds for the whole day.
 *
 * Six panneaux dans une seule vue, et un seul store : ils partagent tous
 * `settings/update`, et c'est le hub qui tranche ce qu'il retient. Le store ne
 * deduces nothing — it lays down again what the hub answered.
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

/** What the hub would deduce from the imported program, settings ignored. */
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
   * Saves, then lays down again what the hub answered.
   *
   * And not what the page would have deduced in its place: the hub decides, and the
   * gap between the two is precisely what an operator comes to check after saving.
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
   * Re-imports from the **saved** URL, never from the one on screen.
   *
   * It is what the hub will read anyway: starting from another would suggest one
   * had imported what one had just typed.
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

/** Emptied means going back to the deduction. Telling "empty" from "absent" is the whole point. */
export function orNull(value: string): string | null {
  return value.trim() === '' ? null : value.trim()
}

/** What each step of the storage check says. */
export const STORAGE_STEPS: Record<string, string> = {
  joindre: 'Joindre le stockage',
  authentifier: 'Clés et bucket',
  signer: 'Adresse signée',
  nettoyer: 'Nettoyage',
}
