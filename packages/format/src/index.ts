/**
 * Formatting shared by every surface — console, room control, and the pages
 * that stayed string templates.
 *
 * Pure TypeScript, no dependency, and **no DOM**: the server imports it too,
 * and so does the browser bundle of `@cloudnord/room-state`.
 *
 * What is *not* here: anything that needs to know what time it is. The hub's
 * clock offset is state, not formatting — it belongs to the clock store.
 */
export { escapeHtml } from './html.js'
export { duration, remaining, shortDuration, stopwatch } from './duration.js'
export { time, timeAgo, timeFormatter } from './instants.js'
export { fileSize } from './bytes.js'
