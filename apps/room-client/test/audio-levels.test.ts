import { describe, expect, it } from 'vitest'
import { LevelAggregator, proportion } from '../src/core/audio-levels.js'
import { multiplierToDb, DB_FLOOR, type InputLevel } from '../src/core/obs.js'

function clock(start = 0) {
  let now = start
  return { read: () => now, advance: (ms: number) => (now += ms) }
}

const input = (name: string, magnitude: number, peak = magnitude): InputLevel => ({
  name,
  channels: [{ magnitude, peak }],
})

describe('converting OBS levels', () => {
  it('translates the multipliers into dBFS', () => {
    // OBS reasons in linear, the sound engineer in dB — and it is the scale OBS
    // displays itself.
    expect(multiplierToDb(1)).toBeCloseTo(0, 5)
    expect(multiplierToDb(0.5)).toBeCloseTo(-6.02, 1)
    expect(multiplierToDb(0.1)).toBeCloseTo(-20, 5)
  })

  it('bounds silence instead of returning minus infinity', () => {
    // `-Infinity` would break every bar-width computation on the page side.
    expect(multiplierToDb(0)).toBe(DB_FLOOR)
    expect(multiplierToDb(-1)).toBe(DB_FLOOR)
    expect(Number.isFinite(multiplierToDb(Number.NaN))).toBe(true)
  })

  it('places the level on a usable scale', () => {
    expect(proportion(0)).toBe(1)
    expect(proportion(-30)).toBeCloseTo(0.5, 5)
    expect(proportion(-90)).toBe(0)
  })
})

describe('VU meter aggregation', () => {
  it('brings 50 measurements a second down to the display cadence', () => {
    const time = clock()
    const received: InputLevel[][] = []
    const aggregator = new LevelAggregator((inputs) => received.push(inputs), 100, time.read)

    // One second of OBS measurements, every 20 ms.
    for (let i = 0; i < 50; i += 1) {
      aggregator.push([input('Micro', -30)])
      time.advance(20)
    }
    // Ten sends rather than fifty: it is what keeps the state stream silent at
    // rest.
    expect(received.length).toBeLessThanOrEqual(11)
    expect(received.length).toBeGreaterThanOrEqual(9)
  })

  it('keeps the briefest peak between two sends', () => {
    // The point that matters: sampling one measurement in five would miss a
    // tenth-of-a-second clip — precisely what one watches for.
    const time = clock()
    const received: InputLevel[][] = []
    const aggregator = new LevelAggregator((inputs) => received.push(inputs), 100, time.read)

    aggregator.push([input('Micro', -40)])
    time.advance(20)
    aggregator.push([input('Micro', -2, -1)])
    time.advance(20)
    aggregator.push([input('Micro', -40)])
    time.advance(100)
    aggregator.push([input('Micro', -40)])

    expect(received[0]![0]!.channels[0]!.magnitude).toBe(-2)
    expect(received[0]![0]!.channels[0]!.peak).toBe(-1)
  })

  it('follows each input separately, and each channel', () => {
    const time = clock()
    const received: InputLevel[][] = []
    const aggregator = new LevelAggregator((inputs) => received.push(inputs), 100, time.read)

    aggregator.push([
      { name: 'Micro', channels: [{ magnitude: -30, peak: -28 }] },
      { name: 'Ambiance', channels: [{ magnitude: -50, peak: -50 }, { magnitude: -12, peak: -10 }] },
    ])
    time.advance(150)
    aggregator.push([{ name: 'Micro', channels: [{ magnitude: -35, peak: -35 }] }])

    const [mic, ambience] = received[0]!
    expect(mic!.channels[0]!.magnitude).toBe(-30)
    // The right channel's clipping must not be drowned by the left channel.
    expect(ambience!.channels[1]!.magnitude).toBe(-12)
    expect(ambience!.channels[0]!.magnitude).toBe(-50)
  })

  it('falls back to silence rather than freezing the last measurement', () => {
    // OBS disconnected: a silent control app must not keep showing a signal,
    // otherwise one believes the microphone is open.
    const time = clock()
    const received: InputLevel[][] = []
    const aggregator = new LevelAggregator((inputs) => received.push(inputs), 100, time.read)

    aggregator.push([input('Micro', -10)])
    aggregator.reset()
    time.advance(500)
    aggregator.push([input('Micro', -45)])

    expect(received.at(-1)![0]!.channels[0]!.magnitude).toBe(-45)
  })
})
