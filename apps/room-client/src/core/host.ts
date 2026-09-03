import { readFileSync } from 'node:fs'
import { cpus, freemem, platform, totalmem } from 'node:os'
import type { HostLoad } from '@cloudnord/contract'

/**
 * The load of the machine running the room.
 *
 * The host, here, is the machine under OBS: the one that encodes, writes the
 * rushes and serves the screen. When it saturates, nothing says so — OBS drops
 * frames silently and the rush is bad without anyone noticing before the editing.
 * That is this module's only reason to exist: to make visible, in the control
 * room, what the room cannot hear.
 */
export type { HostLoad }

export interface HostMonitorDeps {
  readCpus?: () => { times: { user: number; nice: number; sys: number; idle: number; irq: number } }[]
  now?: () => number
  readMemory?: () => HostLoad['memory']
}

/**
 * `MemAvailable` rather than `freemem()` under Linux.
 *
 * There, `freemem()` counts the disk cache as used: a perfectly healthy machine
 * shows more than 90 % of its memory taken, and the badge would stay red
 * permanently — the surest way to get it ignored the day it tells the truth.
 * Windows, the room machine, does not have that quirk; the development machines
 * do.
 */
function availableMemory(): number | null {
  if (platform() !== 'linux') return null
  try {
    const found = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB$/m)
    return found == null ? null : Number(found[1]) * 1024
  } catch {
    return null
  }
}

/** The system's memory, used and total. */
function systemMemory(): HostLoad['memory'] {
  const total = totalmem()
  if (!(total > 0)) return null
  const free = availableMemory() ?? freemem()
  return { usedBytes: Math.max(0, total - free), totalBytes: total }
}

/**
 * Below this, we return the previous reading rather than a new measurement.
 *
 * The kernel's counters are cumulative: two readings close together cover almost
 * nothing and give a figure that jumps from 0 to 100 without the load having
 * moved. Two control windows open would be enough to produce that.
 */
const MIN_WINDOW_MS = 1000

interface Totals {
  total: number
  idle: number
  cores: number
}

function totals(list: ReturnType<NonNullable<HostMonitorDeps['readCpus']>>): Totals {
  let total = 0
  let idle = 0
  for (const core of list) {
    const t = core.times
    total += t.user + t.nice + t.sys + t.idle + t.irq
    idle += t.idle
  }
  return { total, idle, cores: list.length }
}

/**
 * Returns a reading function, to be called when one wants to know.
 *
 * Deliberately with no internal timer: nothing runs while nobody is watching, and
 * the measured window is exactly the interval between two consultations of the
 * control app. A room whose control app is closed pays nothing.
 */
export function hostMonitor(deps: HostMonitorDeps = {}): () => HostLoad {
  const read = deps.readCpus ?? ((): ReturnType<NonNullable<HostMonitorDeps['readCpus']>> => cpus())
  const readMemory = deps.readMemory ?? systemMemory
  const now = deps.now ?? Date.now

  let mark = totals(read())
  let markAt = now()
  let lastCpu: { cpu: number | null; cores: number; windowMs: number } = {
    cpu: null,
    cores: mark.cores,
    windowMs: 0,
  }

  return () => {
    const at = now()
    // Memory is a snapshot, not a difference: it is read back on every call, even
    // when the processor's window is too short to count.
    const memory = readMemory()
    if (at - markAt < MIN_WINDOW_MS) return { ...lastCpu, memory }

    const current = totals(read())
    const total = current.total - mark.total
    const idle = current.idle - mark.idle
    const windowMs = at - markAt
    mark = current
    markAt = at

    // Counters standing still or restarted from zero (sleep, a migrated virtual
    // machine): we keep the last honest figure rather than inventing one.
    if (total <= 0) return { ...lastCpu, memory }

    lastCpu = {
      cpu: Math.min(1, Math.max(0, (total - idle) / total)),
      cores: current.cores,
      windowMs,
    }
    return { ...lastCpu, memory }
  }
}
