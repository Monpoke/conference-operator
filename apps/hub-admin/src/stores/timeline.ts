/**
 * The arithmetic of the montage's timeline, apart from any drawing: what part of
 * the take is in view, and what each pixel of it shows.
 */

export interface TimelineView {
  fromMs: number
  toMs: number
}

export interface Niveaux {
  frameMs: number
  db: number[]
}

/** Closer than this, a pixel is a fraction of a frame and shows nothing more. */
export const MIN_SPAN_MS = 2_000

/** The view, kept inside the take without changing its span when it can. */
export function clampView(view: TimelineView, takeMs: number): TimelineView {
  const span = Math.min(takeMs, Math.max(Math.min(MIN_SPAN_MS, takeMs), view.toMs - view.fromMs))
  const fromMs = Math.min(takeMs - span, Math.max(0, view.fromMs))
  return { fromMs, toMs: fromMs + span }
}

/** Zooms keeping `atMs` under the pointer. A factor below 1 goes closer. */
export function zoomAround(view: TimelineView, atMs: number, factor: number, takeMs: number): TimelineView {
  const span = view.toMs - view.fromMs
  const next = Math.min(takeMs, Math.max(Math.min(MIN_SPAN_MS, takeMs), span * factor))
  const ratio = span === 0 ? 0 : (atMs - view.fromMs) / span
  return clampView({ fromMs: atMs - ratio * next, toMs: atMs - ratio * next + next }, takeMs)
}

/** The view of `spanMs` centred on `atMs`. */
export function centredOn(atMs: number, spanMs: number, takeMs: number): TimelineView {
  return clampView({ fromMs: atMs - spanMs / 2, toMs: atMs + spanMs / 2 }, takeMs)
}

/** The roundest step leaving about `minPx` between two graduations. */
export function tickStep(spanMs: number, widthPx: number, minPx = 90): number {
  const steps = [100, 200, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000]
  const wanted = (spanMs / Math.max(1, widthPx)) * minPx
  return steps.find((step) => step >= wanted) ?? 3_600_000
}

/**
 * What a level is drawn against: the room's quiet below, the voice's loud above.
 *
 * Takes were recorded anywhere from -30 to -52 LUFS: on a fixed scale the quiet
 * ones would draw a flat line, and nobody could see where a sentence starts.
 */
export function levelScale(db: readonly number[]): { floor: number; top: number } {
  if (db.length === 0) return { floor: -90, top: 0 }
  const sorted = [...db].sort((a, b) => a - b)
  const floor = sorted[Math.floor(sorted.length * 0.05)]!
  const top = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.999))]!
  return { floor, top: Math.max(top, floor + 1) }
}

/** Per pixel, between 0 and 1: the loudest frame it covers, so a short word never vanishes. */
export function levelsFor(niveaux: Niveaux, view: TimelineView, widthPx: number, scale: { floor: number; top: number }): Float32Array {
  const levels = new Float32Array(Math.max(0, widthPx))
  const msPerPx = (view.toMs - view.fromMs) / Math.max(1, widthPx)
  for (let x = 0; x < levels.length; x += 1) {
    const first = Math.floor((view.fromMs + x * msPerPx) / niveaux.frameMs)
    const last = Math.max(first, Math.ceil((view.fromMs + (x + 1) * msPerPx) / niveaux.frameMs) - 1)
    let loudest = Number.NEGATIVE_INFINITY
    for (let i = first; i <= last && i < niveaux.db.length; i += 1) loudest = Math.max(loudest, niveaux.db[i]!)
    levels[x] = loudest === Number.NEGATIVE_INFINITY ? 0 : Math.min(1, Math.max(0, (loudest - scale.floor) / (scale.top - scale.floor)))
  }
  return levels
}
