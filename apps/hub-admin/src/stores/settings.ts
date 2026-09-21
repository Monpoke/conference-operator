import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session.js'

/**
 * What is set once, and holds for the whole day.
 *
 * Six panels in a single view, and a single store: they all share
 * `settings/update`, and it is the hub that settles what it keeps. The store
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
  /** The walls.io wall's embed address. `null` = no social wall screen. */
  wallsIoUrl?: string | null
  /** The screens withdrawn from this edition — a deny list; see the contract. */
  screensDisabled?: string[]
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

/**
 * A room's streaming destination, as the console is allowed to see it.
 *
 * No key, ever — `hasKey` is the whole of what comes back. See
 * `roomStreamSchema` in the contract for why.
 */
export interface RoomStream {
  roomId: string
  name: string
  rtmpUrl: string
  hasKey: boolean
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Settings | null>(null)
  const derived = ref<DerivedIdentity>({ name: '', shortName: '' })
  const snapshots = ref<Snapshot[]>([])
  const rooms = ref<{ id: string; name: string }[]>([])
  const streams = ref<RoomStream[]>([])
  const storage = ref<StorageStatus | null>(null)
  /**
   * The programme's images, as the hub holds them.
   *
   * The rooms fetch them from the hub rather than from the upstream export — an
   * image the hub could not get is therefore missing on every screen at once, and
   * this is the page from which the export gets corrected.
   */
  const images = ref<{ held: number; failed: { url: string; reason: string; at: string }[] }>({
    held: 0,
    failed: [],
  })

  const session = useSessionStore()

  async function load(): Promise<void> {
    const [
      settingsData,
      identityData,
      snapshotsData,
      roomsData,
      storageData,
      imagesData,
      streamsData,
    ] = await Promise.all([
      session.client.rpc.settings.get(),
      session.client.rpc.event.identity(),
      session.client.rpc.program.snapshots(),
      session.client.rpc.rooms.list(),
      session.client.rpc.vod.status(),
      session.client.rpc.program.images(),
      session.client.rpc.rooms.streams(),
    ])
    settings.value = settingsData as Settings
    const identity = identityData as { derived?: DerivedIdentity }
    if (identity.derived != null) derived.value = identity.derived
    snapshots.value = snapshotsData as Snapshot[]
    rooms.value = roomsData as { id: string; name: string }[]
    storage.value = storageData as StorageStatus
    images.value = imagesData as typeof images.value
    streams.value = streamsData as RoomStream[]
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
    const result = (await session.client.rpc.program.import({ sourceUrl: url })) as {
      program: { sessions: unknown[] }
    }
    await load()
    return result.program.sessions.length
  }

  async function resync(roomId: string | null): Promise<{ rooms: number }> {
    return (await session.client.rpc.rooms.resync({ roomId })) as { rooms: number }
  }

  /**
   * Sets a room's destination, then lays down what the hub answered.
   *
   * `streamKey` left out means "unchanged" all the way down to the column — see
   * `roomStreamPatchSchema`. The page must therefore send it only when the
   * operator actually typed one, which is what lets a server address be
   * corrected without the key being retyped from the sheet it came on.
   */
  async function setStream(patch: {
    roomId: string
    rtmpUrl: string
    streamKey?: string | null
  }): Promise<RoomStream> {
    const updated = (await session.client.rpc.rooms.setStream(patch)) as RoomStream
    streams.value = streams.value.map((item) =>
      item.roomId === updated.roomId ? updated : item,
    )
    return updated
  }

  async function checkStorage(): Promise<StorageCheck> {
    return (await session.client.rpc.vod.check()) as StorageCheck
  }

  return {
    settings,
    derived,
    snapshots,
    rooms,
    streams,
    storage,
    images,
    load,
    update,
    activate,
    reimport,
    resync,
    setStream,
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
