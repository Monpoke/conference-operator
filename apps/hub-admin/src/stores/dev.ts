import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useConferencesStore } from './conferences.js'
import { useSessionStore } from './session.js'

/**
 * The conveniences that move the whole system.
 *
 * The hub's clock is alone there, and that is already a lot: changing it realigns
 * the three rooms, falsifies the VOD timecodes and triggers automatic closures out
 * of step. It has no business beside the settings one touches on the day — hence a
 * separate view, rendered only in dev mode, and a module the router loads on demand
 * so it does not enter the bundle served in production.
 */
export interface Clock {
  serverTime: string
  simulated: boolean
  controllable: boolean
}

export interface ResetReport {
  objets: number
  multiparts: number
  salles: number
}

export const useDevStore = defineStore('dev', () => {
  const clock = ref<Clock | null>(null)
  const report = ref<ResetReport | null>(null)

  const session = useSessionStore()

  async function load(): Promise<void> {
    clock.value = (await session.client.rpc.clock.get()) as Clock
  }

  async function setClock(at: string | null): Promise<void> {
    const result = (await session.client.rpc.clock.set({ at })) as Omit<Clock, 'controllable'>
    clock.value = { ...result, controllable: true }
  }

  /** What the reset will target, said before offering it. */
  async function resetTarget(): Promise<{ target: string; rooms: number }> {
    let target = 'le préfixe du bucket'
    try {
      const status = (await session.client.rpc.vod.status()) as {
        bucket?: string | null
        prefix?: string | null
      }
      target =
        status.prefix == null || status.prefix === ''
          ? 'AUCUN PRÉFIXE RÉGLÉ'
          : `${status.bucket ?? '?'} / ${status.prefix}`
    } catch {
      // The hub does not answer: we open anyway, it will refuse by itself.
    }
    const rooms = (await session.client.rpc.rooms.list().catch(() => [])) as unknown[]
    return { target, rooms: rooms.length }
  }

  async function reset(): Promise<ResetReport> {
    report.value = (await session.client.rpc.vod.reset({ confirmation: 'RAZ' })) as ResetReport
    return report.value
  }

  return { clock, report, load, setClock, resetTarget, reset }
})

/**
 * The moments in the program one can jump to.
 *
 * Deduced from the imported program, never hard-coded: a date for one edition in
 * the code only holds for that edition, and the buttons became silently useless
 * when the event changed — a jump to a date with no slot at all shows nothing and
 * does not say why.
 */
export function programMoments(
  sessions: { startsAt: string; endsAt?: string | null; kind: string }[],
): [string, string][] {
  const slots = sessions.filter((session) => session.startsAt)
  if (slots.length === 0) return []
  const sorted = [...slots].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
  const first = sorted[0]!
  const last = sorted[sorted.length - 1]!
  const talks = sorted.filter((session) => session.kind !== 'break')
  /**
   * The first **talk**, not the day's first slot.
   *
   * A day opens on a welcome or a breakfast, which are breaks: the button therefore
   * led to 08:35 on an export whose first talk is at 09:00, and one believed the
   * clock wrong when it was the label. It is the same rule as the midday one just
   * below, and as `talkToControl` in the control app — a slot one cannot start is
   * not a moment to jump to.
   *
   * The fallback on the first slot covers a program that would have only breaks:
   * four buttons beat three, even if this one then aims at a lunch.
   */
  const firstTalk = talks[0] ?? first
  const midday = talks[Math.floor(talks.length / 2)] ?? sorted[Math.floor(sorted.length / 2)]!

  const shift = (iso: string, minutes: number): string =>
    new Date(Date.parse(iso) + minutes * 60_000).toISOString()

  const moments: [string, string][] = [
    // This one does aim at the **first slot**, break included: "before opening"
    // means before the room opens its doors.
    ['Avant ouverture', shift(first.startsAt, -30)],
    ['Première conférence', shift(firstTalk.startsAt, 5)],
    ['Milieu de journée', shift(midday.startsAt, 5)],
    // Five minutes after the last slot's end: that is when the automatic closure
    // fires, and that is what one comes to check.
    ['Fin de journée', shift(last.endsAt ?? last.startsAt, 5)],
  ]
  // Deduplicated: on a single-slot program, four buttons leading to the same
  // instant read as four choices.
  const seen = new Set<string>()
  return moments.filter(([, iso]) => (seen.has(iso) ? false : (seen.add(iso), true)))
}

/** An ISO instant, in the shape a `datetime-local` accepts. */
export function forInput(iso: string): string {
  const date = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The active program, for the clock shortcuts. */
export function activeSessions(): { startsAt: string; endsAt?: string | null; kind: string }[] {
  return useConferencesStore().planning?.sessions ?? []
}
