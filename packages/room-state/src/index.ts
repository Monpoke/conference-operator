/**
 * A room's state machine: where it stands, and what you are allowed to do there.
 *
 * Two state machines, really, and the distinction carries the rest:
 *
 * - `lifecycle` is the only **stored** state — `scheduled → running → ended`,
 *   written by the hub on an operator's decision or by the scheduling rule;
 * - `state` is **computed**: it crosses the program with that lifecycle to say,
 *   in one word, where the room stands. Nothing persists it, it is recomputed on
 *   every read.
 *
 * `appearance` translates the second into a colour and a word, so that the hub
 * console and the control app can no longer describe the same room differently.
 *
 * The `@conference-operator/room-state/browser` entry serves the subset that build-less
 * pages inline — see `src/browser.ts`.
 */
export * from './state.js'
export * from './lifecycle.js'
export * from './appearance.js'
export { MACHINE_JS } from './generated/browser.js'
