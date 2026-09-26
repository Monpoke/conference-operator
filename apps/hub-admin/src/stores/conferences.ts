import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useSessionStore } from './session.js'

/**
 * The talks, from two angles that do not replace each other.
 *
 * The first table shows only what has been **started**: it answers "where are we".
 * The schedule answers "and what comes next" — the question the organiser is asked
 * all day long, and for which one had until now to reopen the event's website.
 */
export interface SessionState {
  sessionId: string
  roomId?: string | null
  roomName?: string | null
  title?: string | null
  status: string
  scheduledStartsAt?: string | null
  scheduledEndsAt?: string | null
  remainingMs?: number | null
  decidedBy?: string | null
}

export interface PlannedSession {
  id: string
  roomId?: string | null
  roomName?: string | null
  title: string
  kind: string
  speakers: string[]
  startsAt: string
  endsAt?: string | null
  startedAt?: string | null
  endedAt?: string | null
  decidedBy?: string | null
  feedbackUrl?: string | null
  feedbackIdOverride?: string | null
  overriddenAs?: string | null
  /** A break inherited from another room: it has no existence of its own. */
  sharedFrom?: string | null
  /** The export slot this talk occupies after a swap, or `null`. */
  movedTo?: string | null
}

export interface Planning {
  sessions: PlannedSession[]
  rooms: { id: string; name: string }[]
  timezone: string
  /** The hub's time — it may be simulated, and it is authoritative. */
  serverTime: string
  openFeedbackProjectId?: string | null
  /** The forced talk of each room that has one (`roomId → sessionId`). */
  pins?: Record<string, string>
}

export interface FeedbackCheck {
  projet: string
  projetTrouve: boolean
  detail: string
  talksConnus?: number | null
  manquants: { title: string; feedbackId: string }[]
}

export const useConferencesStore = defineStore('conferences', () => {
  const states = ref<SessionState[]>([])
  const planning = ref<Planning | null>(null)
  const hasActiveProgram = ref(true)
  const room = ref('')

  /** Read from the planning, never kept apart: a pin lifts itself on the hub side. */
  const pins = computed<Record<string, string>>(() => planning.value?.pins ?? {})

  /** Collapsed by default — see `ConferencesView`. */
  const actionsShown = ref(false)

  const session = useSessionStore()

  async function load(): Promise<void> {
    const [sessionStates, snapshots, plan] = await Promise.all([
      session.client.rpc.sessions.states({ roomId: null }),
      session.client.rpc.program.snapshots(),
      session.client.rpc.program.planning(),
    ])
    states.value = sessionStates as SessionState[]
    hasActiveProgram.value = (snapshots as { active?: boolean }[]).some((s) => s.active === true)
    planning.value = plan as Planning
  }

  /** Start, end, put back as upcoming — the lifecycle table decides. */
  async function decide(sessionId: string, action: 'start' | 'end' | 'reset'): Promise<void> {
    await session.client.rpc.sessions[action]({ sessionId })
    await load()
  }

  /**
   * Treating a slot as something other than what the export says.
   *
   * Read back from the hub afterwards: it is the hub that serves the corrected
   * program, and rebuilding it here would make it diverge from what the rooms see.
   */
  async function override(sessionId: string, action: 'talk' | 'break' | null): Promise<void> {
    await session.client.rpc.sessions.override({ sessionId, action })
    await load()
  }

  /**
   * Swapping two talks' slots — room and times — without a reimport.
   *
   * Read back from the hub, as `override`: every screen follows the served
   * program, and the console must show that one.
   */
  async function swap(a: string, b: string): Promise<void> {
    await session.client.rpc.sessions.swap({ a, b })
    await load()
  }

  /** Every swapped slot back to the export. */
  async function resetSlots(): Promise<void> {
    await session.client.rpc.sessions.resetSlots()
    await load()
  }

  /** Forcing a room's current talk, whatever the clock says; `null` lifts it. */
  async function pin(roomId: string, sessionId: string | null): Promise<void> {
    await session.client.rpc.sessions.pin({ roomId, sessionId })
    await load()
  }

  async function setFeedbackId(sessionId: string, feedbackId: string | null): Promise<void> {
    await session.client.rpc.sessions.feedbackId({ sessionId, feedbackId })
    await load()
  }

  /**
   * Checking the OpenFeedback links.
   *
   * On demand and not continuously: it leaves the hub to query a third-party
   * service, and it is a pre-event gesture — one runs it once the program has been
   * imported, corrects what it reports, and never comes back to it.
   */
  async function checkFeedback(): Promise<FeedbackCheck> {
    return (await session.client.rpc.program.controleOpenFeedback()) as FeedbackCheck
  }

  async function vodFolder(sessionId: string): Promise<unknown> {
    return await session.client.rpc.vod.conference({ sessionId })
  }

  async function requestVod(roomId: string, file: string | null): Promise<void> {
    await session.client.rpc.vod.request({ roomId, file })
  }

  return {
    states,
    planning,
    hasActiveProgram,
    room,
    actionsShown,
    load,
    decide,
    override,
    swap,
    resetSlots,
    pin,
    pins,
    setFeedbackId,
    checkFeedback,
    vodFolder,
    requestVod,
  }
})

/** Where the day stands for this slot, according to the hub's time. */
export function placeInDay(session: PlannedSession, nowMs: number): 'a-venir' | 'en-cours' | 'passe' {
  const start = Date.parse(session.startsAt)
  const end = session.endsAt == null ? null : Date.parse(session.endsAt)
  if (start > nowMs) return 'a-venir'
  // End unknown: the slot runs until proven otherwise, rather than be declared
  // past the second it begins.
  if (end == null || nowMs < end) return 'en-cours'
  return 'passe'
}

/**
 * The action the menu offers.
 *
 * The one that **contradicts** the export: the other would do nothing. A slot
 * already decided therefore offers to go back on it, and the empty choice hands it
 * back to the program.
 */
export function overrideChoice(session: PlannedSession): {
  scheduled: 'talk' | 'break'
  action: 'talk' | 'break'
} {
  const decided = session.overriddenAs ?? null
  const scheduled =
    decided == null ? (session.kind as 'talk' | 'break') : decided === 'break' ? 'talk' : 'break'
  return { scheduled, action: scheduled === 'break' ? 'talk' : 'break' }
}

/**
 * Why this row cannot be swapped, or `null` when it can.
 *
 * The hub's own refusals, said before the click rather than after: a menu that
 * offers a swap the hub will refuse costs a round trip at the worst moment. A
 * talk already started keeps its slot — its lifecycle was written for the room
 * and the hour it had.
 */
export function swapBlocked(session: PlannedSession): string | null {
  if (session.sharedFrom != null) return "Pause héritée d'une autre salle"
  if (session.kind !== 'talk') return "Seule une conférence s'échange"
  if (session.endedAt != null) return 'Conférence déjà terminée'
  if (session.startedAt != null) return 'Conférence déjà commencée'
  return null
}

/**
 * The talks this one can trade its slot with: the same day, in the event's zone.
 *
 * Another day is not refused by the hub, but it is never what is meant in an
 * emergency — and it would triple the menu.
 */
export function swapPartners(
  session: PlannedSession,
  sessions: PlannedSession[],
  timezone: string,
): PlannedSession[] {
  if (swapBlocked(session) != null) return []
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, dateStyle: 'short' })
  const today = day.format(new Date(session.startsAt))
  return sessions.filter(
    (other) =>
      other.id !== session.id &&
      swapBlocked(other) == null &&
      day.format(new Date(other.startsAt)) === today,
  )
}

/** The partners, grouped by room, rooms in the order they first come. */
export function partnersByRoom(
  partners: PlannedSession[],
): { room: string; sessions: PlannedSession[] }[] {
  const groups = new Map<string, PlannedSession[]>()
  for (const partner of partners) {
    const room = partner.roomName ?? partner.roomId ?? '—'
    groups.set(room, [...(groups.get(room) ?? []), partner])
  }
  return [...groups].map(([room, sessions]) => ({ room, sessions }))
}

/**
 * Whether "force it now" makes sense: a talk of a room, not over yet.
 *
 * The hub lifts a pin by itself once its talk ends — offering it on an ended talk
 * would be a gesture that undoes itself.
 */
export function canPin(session: PlannedSession): boolean {
  return (
    session.roomId != null &&
    session.kind === 'talk' &&
    session.sharedFrom == null &&
    session.endedAt == null
  )
}
