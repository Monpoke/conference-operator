import type { RoomConferenceState } from './state.js'

/**
 * What each state paints, and the word that goes with it.
 *
 * The word is not decorative: the status dot is read from a distance, and not
 * everyone tells the hues apart.
 *
 * This table used to exist twice — once in the control app, once in the hub
 * console — and the two copies had already drifted: the same `aucune` state read
 * "hors créneau" on one side and "rien au programme" on the other, for a room
 * that was in the same state. Two people looking at two screens must be able to
 * say the same thing to each other over the phone.
 */
export interface Appearance {
  /** Status-dot class suffix. Empty for the nominal state, which is green. */
  tint: string
  /** The word shown next to it. */
  word: string
  /** Colour class of the text accompanying the status dot. */
  text: string
}

export const APPEARANCE: Record<RoomConferenceState, Appearance> = {
  aucune: { tint: 'hors', word: 'hors créneau', text: 'text-attenue' },
  // A shared slot is not a room state: there is nobody there.
  // "pause" made it sound like a talk on hold.
  pause: { tint: 'hors', word: 'rien dans la salle', text: 'text-attenue' },
  'pas-commencee': { tint: 'pas-commencee', word: 'pas commencée', text: 'text-attenue' },
  retard: { tint: 'retard', word: 'retard au démarrage', text: 'text-attention' },
  'en-cours': { tint: '', word: 'en cours', text: 'text-attenue' },
  'fin-proche': { tint: 'fin-proche', word: 'vers la fin', text: 'text-attention' },
  terminee: { tint: 'terminee', word: 'terminée en avance', text: 'text-attenue' },
  depassement: { tint: 'depassement', word: 'dépassement', text: 'text-alerte' },
}

/**
 * Appearance of a state, including one we do not know.
 *
 * A hub on a newer version may name a state this page ignores. Falling back to
 * `aucune` shows a neutral status dot rather than breaking the rendering of the
 * whole room list.
 */
export function appearanceOf(state: string | null | undefined): Appearance {
  return APPEARANCE[state as RoomConferenceState] ?? APPEARANCE.aucune
}

/**
 * What the status dot's outline says about the room, on top of its fill.
 *
 * Second half of the table above, and for the same reason: it lived in two
 * copies — one in the control app, one in the console — and the two had already
 * stopped saying the same thing. On a room whose connectivity was unknown, the
 * control app painted a filled dot and the console a hollow one: two screens
 * side by side, one claiming a room was fine, the other that we knew nothing.
 *
 * The hollow version is the one kept. The outline does not say the state of the
 * talk, it says how much we trust what we are showing; knowing nothing and
 * painting it in colour is precisely what it exists against. A missing value
 * does not come from an up-to-date hub — `connectivitySchema` is a mandatory
 * enum — but it does come from a room the hub has not seen yet, and that is
 * where the question arises.
 */
export function outlineOf(connectivity: string | null | undefined): string {
  if (connectivity === 'DEGRADED') return ' doute'
  return connectivity === 'ONLINE' ? '' : ' muette'
}

/**
 * States only the hub can observe: they hinge on the talk lifecycle, which the
 * control app does not receive for other rooms.
 */
export const HUB_ONLY_STATES: readonly RoomConferenceState[] = [
  'pas-commencee',
  'retard',
  'terminee',
  'depassement',
]

/** Freshness beyond which the hub's view stops being authoritative. */
export const STALE_VIEW_MS = 60_000

/**
 * Who is right about another room's state, the local program or the hub.
 *
 * The split is not arbitrary. The cached program is recomputed every second, on
 * the hub's clock: it is the most accurate for everything derived from a
 * schedule — running, ending soon, break. Taking the hub's view over it, which
 * refreshes every few seconds, would miss the switch to "ending soon", which is
 * exactly what we are watching for.
 *
 * The hub, in turn, is alone in knowing that a slot started without anyone
 * launching it, or that a room is overrunning. On those states it is
 * authoritative — as long as its view is fresh. Past a minute it describes a
 * past, and the program becomes the better answer again: during an outage, the
 * room next door still finishes on schedule.
 */
export function authoritativeState(
  local: RoomConferenceState,
  hubView: string | null | undefined,
  viewIsFresh: boolean,
): RoomConferenceState {
  if (!viewIsFresh || hubView == null) return local
  return HUB_ONLY_STATES.includes(hubView as RoomConferenceState)
    ? (hubView as RoomConferenceState)
    : local
}
