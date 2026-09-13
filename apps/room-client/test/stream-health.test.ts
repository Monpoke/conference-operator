import { describe, expect, it } from 'vitest'
import { streamHealthBetween, type StreamSample } from '../src/core/stream-health.js'

const sample = (overrides: Partial<StreamSample>): StreamSample => ({
  atMs: 0,
  outputBytes: 0,
  skippedFrames: 0,
  totalFrames: 0,
  congestion: 0,
  ...overrides,
})

describe('stream health', () => {
  it('measures a rate between two samples, not the total sent so far', () => {
    // Ten seconds, 5.625 MB sent: 4 500 kb/s — whatever was sent before.
    const health = streamHealthBetween(
      sample({ atMs: 0, outputBytes: 900_000_000, totalFrames: 30_000 }),
      sample({ atMs: 10_000, outputBytes: 905_625_000, totalFrames: 30_300, congestion: 0.05 }),
    )
    expect(health).toEqual({ bitrateKbps: 4500, skippedRatio: 0, congestion: 0.05 })
  })

  it('counts the skipped frames of the interval only', () => {
    const health = streamHealthBetween(
      sample({ atMs: 0, outputBytes: 1, skippedFrames: 500, totalFrames: 10_000 }),
      sample({ atMs: 10_000, outputBytes: 2, skippedFrames: 512, totalFrames: 10_300 }),
    )
    expect(health?.skippedRatio).toBeCloseTo(0.04)
  })

  it('says nothing until it has two samples, or when the stream restarted', () => {
    expect(streamHealthBetween(null, sample({ atMs: 10_000, outputBytes: 100 }))).toBeNull()
    // Counters back to zero: a new stream, and a negative difference would be nonsense.
    expect(
      streamHealthBetween(sample({ atMs: 0, outputBytes: 5_000 }), sample({ atMs: 10_000, outputBytes: 100 })),
    ).toBeNull()
    expect(streamHealthBetween(sample({ atMs: 10_000 }), sample({ atMs: 10_000 }))).toBeNull()
  })
})
