/**
 * The stream's health, derived from OBS's counters.
 *
 * OBS reports its stream counters **cumulative** since the stream started. A rate
 * only comes from two samples: reading `outputBytes` as a bitrate gave the total
 * sent so far, a figure that only ever grows and says nothing about now.
 */

/** One reading of OBS's stream counters, and when it was taken. */
export interface StreamSample {
  atMs: number
  outputBytes: number
  skippedFrames: number
  totalFrames: number
  congestion: number
}

export interface StreamHealth {
  bitrateKbps: number
  /** Share of the frames skipped between the two samples, 0–1. */
  skippedRatio: number
  congestion: number
}

/**
 * The health between two samples, or `null` when no rate can be derived.
 *
 * `null` on the first sample, when no time has passed, and when a counter went
 * backwards — the stream restarted between the two, and the difference would be
 * negative nonsense. The next pair measures again.
 */
export function streamHealthBetween(previous: StreamSample | null, current: StreamSample): StreamHealth | null {
  if (previous == null) return null
  const elapsedMs = current.atMs - previous.atMs
  const bytes = current.outputBytes - previous.outputBytes
  const frames = current.totalFrames - previous.totalFrames
  const skipped = current.skippedFrames - previous.skippedFrames
  if (elapsedMs <= 0 || bytes < 0 || frames < 0 || skipped < 0) return null
  return {
    bitrateKbps: Math.round((bytes * 8) / 1000 / (elapsedMs / 1000)),
    skippedRatio: frames === 0 ? 0 : Math.min(1, skipped / frames),
    congestion: Math.min(1, Math.max(0, current.congestion)),
  }
}
