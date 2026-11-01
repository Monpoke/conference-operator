import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Planning, PlannedSession } from './conferences.js'
import { useSessionStore } from './session.js'

/**
 * Bringing the takes home.
 *
 * To be looked at **before dismantling a room**: it is the last moment its disk is
 * still plugged in. Footage that is not here exists only on that disk.
 */
export interface Upload {
  roomId: string
  roomName?: string | null
  file: string
  kind: string
  sessionId?: string | null
  state: string
  sizeBytes: number
  bytesSent: number
  debitOctetsS?: number | null
  lastError?: string | null
}

export interface Room {
  id: string
  name: string
}

export const useVodStore = defineStore('vod', () => {
  const uploads = ref<Upload[]>([])
  const rooms = ref<Room[]>([])
  const room = ref<string>('')
  const planning = ref<Planning | null>(null)

  const conferences = computed(() =>
    conferenceRows(
      uploads.value,
      planning.value?.sessions ?? [],
      rooms.value,
      room.value,
      planning.value?.serverTime ?? null,
    ),
  )

  const session = useSessionStore()

  async function load(): Promise<void> {
    const [rows, roomList, plan] = await Promise.all([
      session.client.rpc.vod.uploads({ roomId: room.value === '' ? null : room.value }),
      session.client.rpc.rooms.list(),
      // Without the programme the uploads still group, only less legibly: an
      // operator who cannot read it must keep the view that protects the rushes.
      Promise.resolve()
        .then(() => session.client.rpc.program.planning())
        .catch(() => null),
    ])
    uploads.value = rows as Upload[]
    rooms.value = roomList as Room[]
    planning.value = plan as Planning | null
  }

  /**
   * Requests a repatriation.
   *
   * A null `file` means the whole room. The request targets **one** machine: with
   * no room there is nobody to talk to, and it is the view that says so rather than
   * leave a button with no effect.
   */
  async function request(roomId: string, file: string | null): Promise<void> {
    await session.client.rpc.vod.request({ roomId, file })
    await load()
  }

  return { uploads, rooms, room, planning, conferences, load, request }
})

/** What an upload state says, and in what colour. */
export const UPLOAD_STATES: Record<string, { label: string; tone: string }> = {
  'en-cours': { label: 'en cours', tone: '' },
  termine: { label: 'terminé', tone: 'text-dim' },
  abandonne: { label: 'abandonné', tone: 'text-warn' },
  echoue: { label: 'en échec', tone: 'text-alert' },
}

/** Where one kind of file stands for a talk. */
type Presence = 'oui' | 'en-cours' | 'echec' | 'non'

/** The one thing to read on a line: can this talk's room be dismantled? */
export type Etat = 'a-reprendre' | 'en-cours' | 'a-venir' | 'complet' | 'sans-captation'

/**
 * In the order the view sorts them. Colour is kept for what asks for a gesture:
 * a screen full of green drowns the one line in red.
 */
export const ETATS: Record<Etat, { label: string; tone: string }> = {
  'a-reprendre': { label: 'À reprendre', tone: 'font-semibold text-alert' },
  'en-cours': { label: 'En cours', tone: '' },
  'a-venir': { label: 'À venir', tone: 'text-dim' },
  complet: { label: 'Complet', tone: 'text-dim' },
  'sans-captation': { label: 'Sans captation', tone: 'text-dim' },
}

/** One line of the view: a talk, or the uploads no talk claims. */
export interface ConferenceRow {
  key: string
  /** The room to ask, when no file names it. */
  roomId: string | null
  title: string
  roomName: string
  startsAt: string | null
  files: Upload[]
  etat: Etat
  /** What the files are, or which one is at fault. */
  detail: string
}

/**
 * A failure outranks everything: one rush that arrived does not make up for
 * another one left on the disk.
 */
function presenceOf(files: Upload[], kind: string): Presence {
  const ofKind = files.filter((file) => file.kind === kind)
  if (ofKind.length === 0) return 'non'
  if (ofKind.some((file) => file.state === 'echoue' || file.state === 'abandonne')) return 'echec'
  return ofKind.every((file) => file.state === 'termine') ? 'oui' : 'en-cours'
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count > 1 ? 's' : ''}`
}

/**
 * The sidecar leaves once every piece of its rush has arrived: missing while the
 * rush is on its way is the normal order of things, not an alert.
 */
function etatOf(files: Upload[], rush: Presence, sidecar: Presence, expected: boolean, ended: boolean): Etat {
  if (!expected && files.length === 0) return 'sans-captation'
  if (rush === 'echec' || sidecar === 'echec') return 'a-reprendre'
  if (rush === 'en-cours' || sidecar === 'en-cours') return 'en-cours'
  if (!expected || (rush === 'oui' && sidecar === 'oui')) return 'complet'
  if (ended) return 'a-reprendre'
  return files.length > 0 ? 'en-cours' : 'a-venir'
}

function detailOf(files: Upload[], rush: Presence, sidecar: Presence, expected: boolean, ended: boolean): string {
  if (files.length === 0) return expected && ended ? 'aucun fichier reçu' : ''
  const rushes = files.filter((file) => file.kind === 'rush')
  const sent = rushes.reduce((total, file) => total + file.bytesSent, 0)
  const size = rushes.reduce((total, file) => total + file.sizeBytes, 0)
  const rushPart: Record<Presence, string> = {
    oui: plural(rushes.length, 'rush'),
    echec: 'rush en échec',
    'en-cours': `rush en cours · ${progress({ bytesSent: sent, sizeBytes: size })} %`,
    non: expected ? 'rush manquant' : '',
  }
  const sidecarPart: Record<Presence, string> = {
    oui: 'side-car',
    echec: 'side-car en échec',
    'en-cours': 'side-car en cours',
    non: !expected ? '' : ended && rush === 'oui' ? 'side-car manquant' : 'side-car à suivre',
  }
  return [rushPart[rush], sidecarPart[sidecar]].filter((part) => part !== '').join(' · ')
}

/**
 * The uploads, one line per talk: what asks for a gesture first, then programme order.
 *
 * A talk with nothing uploaded keeps its line: it is the one to see before
 * dismantling a room. No upload is ever dropped: those of no slot, or of a slot
 * gone from the programme, get their own line — with nothing expected of them,
 * since no talk says a sidecar should follow. `uploads` comes most recent first,
 * so the first row of a file is its current attempt.
 */
export function conferenceRows(
  uploads: Upload[],
  sessions: PlannedSession[],
  rooms: Room[],
  roomFilter: string,
  now: string | null,
): ConferenceRow[] {
  const groups = new Map<string, Upload[]>()
  const seen = new Set<string>()
  for (const upload of uploads) {
    const file = `${upload.roomId}/${upload.file}`
    if (seen.has(file)) continue
    seen.add(file)
    const key = upload.sessionId ?? `sans-conference/${upload.roomId}`
    groups.set(key, [...(groups.get(key) ?? []), upload])
  }

  const roomNames = new Map(rooms.map((room) => [room.id, room.name]))
  const line = (
    key: string,
    files: Upload[],
    fields: Pick<ConferenceRow, 'title' | 'roomName' | 'startsAt' | 'roomId'>,
    expected: boolean,
    ended: boolean,
  ): ConferenceRow => {
    const rush = presenceOf(files, 'rush')
    const sidecar = presenceOf(files, 'sidecar')
    return {
      key,
      files,
      ...fields,
      etat: etatOf(files, rush, sidecar, expected, ended),
      detail: detailOf(files, rush, sidecar, expected, ended),
    }
  }

  const planned = sessions
    .filter(
      (session) =>
        groups.has(session.id) ||
        (session.kind !== 'break' &&
          session.sharedFrom == null &&
          (roomFilter === '' || session.roomId === roomFilter)),
    )
    .map((session) =>
      line(session.id, groups.get(session.id) ?? [], {
        title: session.title,
        roomId: session.roomId ?? null,
        roomName: session.roomName ?? (session.roomId == null ? '—' : (roomNames.get(session.roomId) ?? session.roomId)),
        startsAt: session.startsAt,
      }, session.sansCaptation !== true, session.endedAt != null || (session.endsAt != null && now != null && Date.parse(session.endsAt) < Date.parse(now))),
    )
    .sort((a, b) => Date.parse(a.startsAt!) - Date.parse(b.startsAt!))

  const known = new Set(sessions.map((session) => session.id))
  const unplanned = [...groups]
    .filter(([key]) => !known.has(key))
    .map(([key, files]) =>
      line(key, files, {
        title: files[0]!.sessionId == null ? 'Sans conférence' : `Hors programme (${files[0]!.sessionId})`,
        roomName: files[0]!.roomName ?? files[0]!.roomId,
        startsAt: null,
        roomId: files[0]!.roomId,
      }, false, true),
    )

  const order = Object.keys(ETATS)
  return [...planned, ...unplanned].sort((a, b) => order.indexOf(a.etat) - order.indexOf(b.etat))
}

/** How many talks stand in each state. */
export function countByEtat(rows: ConferenceRow[]): Record<Etat, number> {
  const counts: Record<Etat, number> = { 'a-reprendre': 0, 'en-cours': 0, 'a-venir': 0, complet: 0, 'sans-captation': 0 }
  for (const row of rows) counts[row.etat] += 1
  return counts
}

/** Progress as a percentage, bounded: a file that grows in transit would exceed it. */
export function progress(upload: Pick<Upload, 'bytesSent' | 'sizeBytes'>): number {
  if (upload.sizeBytes <= 0) return 0
  return Math.min(100, Math.round((upload.bytesSent / upload.sizeBytes) * 100))
}
