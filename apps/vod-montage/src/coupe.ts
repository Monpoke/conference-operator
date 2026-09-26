/**
 * Where exactly to cut: a mark set by hand, moved onto the silence next to it.
 *
 * An operator presses « Début » when the speaker starts — a word or two late,
 * or a breath early. Cutting there cuts a word in half. The room microphone
 * never goes quiet, so "silence" cannot be a fixed level: it is measured, room
 * by room, from the take itself — the quietest tenth of the window around the
 * mark is its noise floor, and silence is whatever stays close to it.
 *
 * Pure functions: the frames come from ffmpeg (`audio.ts`), the decisions are
 * made here, and tested here.
 */

/** A slice of sound: its start in the take, and its RMS level. */
export interface Frame {
  ms: number
  db: number
}

/** A stretch quiet enough to cut in, in the take's time. */
export interface Silence {
  startMs: number
  endMs: number
}

/** How long each frame lasts — what `audio.ts` asks ffmpeg for. */
export const FRAME_MS = 50
/** Above the noise floor by this much, it is somebody speaking. */
export const SILENCE_MARGIN_DB = 6
/** Shorter than this, it is the gap between two words, not a pause. */
export const MIN_SILENCE_MS = 350

/** The room's noise floor: the tenth percentile of the frames' levels. */
export function noiseFloor(frames: readonly Frame[]): number {
  const levels = frames.map((f) => f.db).filter((db) => Number.isFinite(db)).sort((a, b) => a - b)
  if (levels.length === 0) return -120
  return levels[Math.floor((levels.length - 1) * 0.1)]!
}

/** The runs of frames below the threshold, long enough to be a pause. */
export function silences(
  frames: readonly Frame[],
  thresholdDb: number,
  minMs = MIN_SILENCE_MS,
  frameMs = FRAME_MS,
): Silence[] {
  const found: Silence[] = []
  let start: number | null = null
  let last = 0
  for (const frame of frames) {
    const quiet = !Number.isFinite(frame.db) || frame.db <= thresholdDb
    if (quiet && start == null) start = frame.ms
    if (!quiet && start != null) {
      if (frame.ms - start >= minMs) found.push({ startMs: start, endMs: frame.ms })
      start = null
    }
    last = frame.ms + frameMs
  }
  if (start != null && last - start >= minMs) found.push({ startMs: start, endMs: last })
  return found
}

/** The silences of a window, with the threshold measured from the window itself. */
export function silencesOf(frames: readonly Frame[]): { floorDb: number; silences: Silence[] } {
  const floorDb = noiseFloor(frames)
  return { floorDb, silences: silences(frames, floorDb + SILENCE_MARGIN_DB) }
}

export interface Snapped {
  ms: number
  /** Moved onto a silence; `false`: the mark was kept as set. */
  calee: boolean
  /** How far it moved: negative is earlier. */
  shiftMs: number
}

export interface SnapWindow {
  /** How far before the mark a silence may be looked for. */
  beforeMs: number
  /** How far after. */
  afterMs: number
  /**
   * The pause closest to the instant rather than the one the rule prefers —
   * for an instant known only roughly, the room's button pressed a few
   * seconds off either way.
   */
  nearest?: boolean
}

/** Kept before the first word: a cut on the consonant itself sounds clipped. */
export const LEAD_MS = 250
/** Kept after the last word: the end of a sentence trails. */
export const TAIL_MS = 400

/**
 * The start, moved to where the speaking starts again after the pause the mark
 * sits in or just follows. The latest such pause wins: it is the one right
 * before the first word.
 */
export function snapStart(markMs: number, found: readonly Silence[], window: SnapWindow = { beforeMs: 5_000, afterMs: 1_000 }): Snapped {
  const candidates = found.filter((s) => s.endMs >= markMs - window.beforeMs && s.endMs <= markMs + window.afterMs)
  if (candidates.length === 0) return { ms: markMs, calee: false, shiftMs: 0 }
  const pause = window.nearest
    ? candidates.reduce((a, b) => (Math.abs(b.endMs - markMs) < Math.abs(a.endMs - markMs) ? b : a))
    : candidates.reduce((a, b) => (b.endMs > a.endMs ? b : a))
  const ms = Math.max(pause.startMs, pause.endMs - LEAD_MS)
  return { ms, calee: true, shiftMs: ms - markMs }
}

/**
 * The end, moved to the first pause after the last words. The earliest such
 * pause wins: it is the one right after the talk's last sentence — later ones
 * are the applause, and the next speaker setting up.
 */
export function snapEnd(markMs: number, found: readonly Silence[], window: SnapWindow = { beforeMs: 1_000, afterMs: 5_000 }): Snapped {
  const candidates = found.filter((s) => s.startMs >= markMs - window.beforeMs && s.startMs <= markMs + window.afterMs)
  if (candidates.length === 0) return { ms: markMs, calee: false, shiftMs: 0 }
  const pause = window.nearest
    ? candidates.reduce((a, b) => (Math.abs(b.startMs - markMs) < Math.abs(a.startMs - markMs) ? b : a))
    : candidates.reduce((a, b) => (b.startMs < a.startMs ? b : a))
  const ms = Math.min(pause.endMs, pause.startMs + TAIL_MS)
  return { ms, calee: true, shiftMs: ms - markMs }
}

/**
 * The two ends, snapped, and never crossed: a start snapped past the end —
 * two marks a second apart — keeps both marks as set.
 */
export function snapCut(
  cut: { startMs: number; endMs: number },
  start: Snapped | null,
  end: Snapped | null,
): { startMs: number; endMs: number } {
  const startMs = start?.ms ?? cut.startMs
  const endMs = end?.ms ?? cut.endMs
  return endMs > startMs ? { startMs, endMs } : cut
}
