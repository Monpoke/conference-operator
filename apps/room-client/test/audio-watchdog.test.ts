import { describe, expect, it } from 'vitest'
import type { AudioAlert } from '@conference-operator/contract'
import { AudioWatchdog, DEFAULT_WATCHDOG, watchedInputs } from '../src/core/audio-watchdog.js'

/**
 * The capture watchdog: while a talk is recorded, it listens to the microphone
 * five seconds every thirty, and says when nothing — or too much — comes in.
 */
const MICRO = { name: 'Micro cravate', muted: false }
const ON = { active: true, inputs: [MICRO] }
const level = (magnitude: number, peak = magnitude) => [{ name: MICRO.name, channels: [{ magnitude, peak }] }]

/** A watchdog, and a clock driven second by second, levels pushed while it listens. */
function run() {
  const changes: AudioAlert[][] = []
  const watchdog = new AudioWatchdog((alerts) => changes.push(alerts))
  let now = 0
  const seconds = (count: number, heard: ReturnType<typeof level> | null, context = ON) => {
    for (let i = 0; i < count; i++) {
      if (heard != null) watchdog.push(heard)
      watchdog.tick(now, context)
      now += 1_000
    }
  }
  return { watchdog, changes, seconds, at: () => now }
}

describe('the samples', () => {
  it('listens five seconds every thirty, only while a talk is recorded', () => {
    const { watchdog, seconds } = run()
    seconds(1, null, { active: false, inputs: [MICRO] })
    expect(watchdog.listening()).toBe(false)

    const listened: boolean[] = []
    for (let i = 0; i < 60; i++) {
      seconds(1, level(-20))
      listened.push(watchdog.listening())
    }
    // Five seconds listened in each half-minute, no more.
    expect(listened.filter(Boolean)).toHaveLength(2 * (DEFAULT_WATCHDOG.forMs / 1_000))
  })
})

describe('a microphone that says nothing', () => {
  it('is reported at the second silent sample, not the first: a pause is not a dead mic', () => {
    const { watchdog, seconds } = run()
    seconds(30, level(-60))
    expect(watchdog.alerts()).toEqual([])
    seconds(30, level(-60))
    expect(watchdog.alerts()).toEqual([{ kind: 'silence', input: MICRO.name, since: expect.any(String) }])
  })

  it('is cleared by the first sample that hears it again', () => {
    const { watchdog, changes, seconds } = run()
    seconds(60, level(-60))
    expect(watchdog.alerts()).toHaveLength(1)
    seconds(30, level(-25))
    expect(watchdog.alerts()).toEqual([])
    expect(changes.at(-1)).toEqual([])
  })

  it('is not taken for silent when OBS sends nothing at all for it', () => {
    const { watchdog, seconds } = run()
    seconds(90, null)
    expect(watchdog.alerts()).toEqual([])
  })
})

describe('the other two alerts', () => {
  it('reports a clipping peak at once', () => {
    const { watchdog, seconds } = run()
    seconds(6, level(-12, -0.2))
    expect(watchdog.alerts().map((alert) => alert.kind)).toEqual(['saturation'])
  })

  it('reports a microphone muted in OBS without even listening', () => {
    const { watchdog, seconds } = run()
    seconds(1, null, { active: true, inputs: [{ ...MICRO, muted: true }] })
    expect(watchdog.alerts()).toEqual([{ kind: 'muet', input: MICRO.name, since: expect.any(String) }])
  })

  it('says nothing more once the recording stops', () => {
    const { watchdog, changes, seconds } = run()
    seconds(60, level(-60))
    seconds(1, null, { active: false, inputs: [] })
    expect(watchdog.alerts()).toEqual([])
    expect(watchdog.listening()).toBe(false)
    expect(changes.at(-1)).toEqual([])
  })

  it('keeps when an alert started, while it lasts', () => {
    const { watchdog, seconds } = run()
    seconds(1, null, { active: true, inputs: [{ ...MICRO, muted: true }] })
    const since = watchdog.alerts()[0]!.since
    seconds(45, null, { active: true, inputs: [{ ...MICRO, muted: true }] })
    expect(watchdog.alerts()[0]!.since).toBe(since)
  })
})

describe('the sources listened to', () => {
  const sources = [
    { name: 'Micro cravate', muted: false, capture: true },
    { name: 'Ambiance salle', muted: false, capture: true },
    { name: 'Retour régie', muted: false, capture: false },
    { name: 'Vidéo intro', muted: false },
  ]

  it('are the capture devices, not the desktop audio nor a media file', () => {
    expect(watchedInputs(sources, null).map((source) => source.name)).toEqual(['Micro cravate', 'Ambiance salle'])
  })

  it('is the one the room names, when OBS has it', () => {
    expect(watchedInputs(sources, 'Micro cravate').map((source) => source.name)).toEqual(['Micro cravate'])
    expect(watchedInputs(sources, 'Micro disparu')).toEqual([])
  })
})
