/**
 * What the standalone pages get from the state machine.
 *
 * The pages — control app, hub console — have no build step: they open from a
 * string, with no network, no CDN and no bundler. So they cannot `import`. This
 * module is the entry point `scripts/build-browser.mjs` freezes into
 * `MACHINE_JS`, which the pages inline in a `<script>` — the same pattern as the
 * Tailwind sheet of `@conference-operator/ui`.
 *
 * It exports pure computation only: nothing from zod, nothing from Node, no DOM
 * access. That is what lets the same function decide the colour of a status dot
 * in the console and the state shown in the control app, to the millisecond,
 * without either having to copy a threshold.
 */
export {
  BREAK_SOON_MS,
  DEFAULT_AUTO_END,
  ENDING_SOON_MS,
  LATE_MS,
  ROOM_STATES,
  breakOfSlots,
  effectiveEndAt,
  nextTalk,
  shouldAutoEnd,
  stateFromProgram,
  stateOfSlots,
  talkToControl,
  toAutoEnd,
} from './state.js'
export type {
  AutoEndSetting,
  Break,
  RoomConferenceState,
  SessionStatuses,
  Slot,
} from './state.js'

export {
  APPEARANCE,
  HUB_ONLY_STATES,
  STALE_VIEW_MS,
  appearanceOf,
  authoritativeState,
  outlineOf,
} from './appearance.js'
export type { Appearance } from './appearance.js'

export {
  SESSION_ACTIONS,
  SESSION_STATUSES,
  isDecisionApplicable,
  isTransitionAllowed,
  statusAfter,
  transitionRefusal,
} from './lifecycle.js'
export type { SessionAction, SessionStatus } from './lifecycle.js'

export { timelinePosition } from '@conference-operator/program/selectors'
