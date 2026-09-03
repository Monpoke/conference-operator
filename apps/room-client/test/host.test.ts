import { describe, expect, it } from 'vitest'
import { hostMonitor } from '../src/core/host.js'

/**
 * The machine's load.
 *
 * What these tests protect: a room must never display "0 %" for a processor it
 * failed to measure. A reassuring wrong figure is worth less than no figure at
 * all — it is precisely the opposite of what the badge is meant to show.
 */
function core(user: number, idle: number) {
  return { times: { user, nice: 0, sys: 0, idle, irq: 0 } }
}

describe('hostMonitor', () => {
  it('announces nothing while no window has elapsed', () => {
    const read = hostMonitor({ readCpus: () => [core(0, 0)], now: () => 1_000 })

    // The first call, at the same instant as the mark was set: no duration
    // observed, so no rate to give.
    expect(read().cpu).toBeNull()
  })

  it('measures the busy share between two readings', () => {
    let time = 0
    let cpus = [core(0, 0), core(0, 0)]
    const read = hostMonitor({ readCpus: () => cpus, now: () => time })

    time = 2_000
    // Two cores, 1,000 ticks elapsed each: one busy three quarters of the time,
    // the other a quarter. The machine's load is the average of the two.
    cpus = [core(750, 250), core(250, 750)]
    const load = read()

    expect(load.cpu).toBeCloseTo(0.5, 5)
    expect(load.cores).toBe(2)
    expect(load.windowMs).toBe(2_000)
  })

  it('returns the previous reading when two consultations follow too closely', () => {
    let time = 0
    let cpus = [core(0, 0)]
    const read = hostMonitor({ readCpus: () => cpus, now: () => time })

    time = 2_000
    cpus = [core(800, 200)]
    expect(read().cpu).toBeCloseTo(0.8, 5)

    // A second control window opened: with no guard, it would consume a 100 ms
    // interval and read a rate that means nothing.
    time = 2_100
    cpus = [core(800, 300)]
    expect(read().cpu).toBeCloseTo(0.8, 5)
  })

  it('reads the memory back on every call, even with no processor window', () => {
    let time = 0
    let used = 4_000_000_000
    const read = hostMonitor({
      readCpus: () => [core(0, 0)],
      now: () => time,
      readMemory: () => ({ usedBytes: used, totalBytes: 16_000_000_000 }),
    })

    // Memory is a snapshot, not a difference: it holds from the very first call,
    // where the processor has nothing to say yet.
    expect(read()).toMatchObject({ cpu: null, memory: { usedBytes: 4_000_000_000 } })

    // And it follows, even when two readings follow too closely for the
    // processor's window to count.
    time = 100
    used = 15_000_000_000
    expect(read().memory?.usedBytes).toBe(15_000_000_000)
  })

  it('leaves the memory at null when it is not readable', () => {
    const read = hostMonitor({ readCpus: () => [core(0, 0)], now: () => 0, readMemory: () => null })

    expect(read().memory).toBeNull()
  })

  it('keeps the last honest figure when the counters stop advancing', () => {
    let time = 0
    let cpus = [core(0, 0)]
    const read = hostMonitor({ readCpus: () => cpus, now: () => time })

    time = 2_000
    cpus = [core(600, 400)]
    expect(read().cpu).toBeCloseTo(0.6, 5)

    // A migrated virtual machine, counters gone backwards: inventing a rate here
    // would show a saturated room that is not.
    time = 4_000
    cpus = [core(0, 0)]
    expect(read().cpu).toBeCloseTo(0.6, 5)
  })
})
