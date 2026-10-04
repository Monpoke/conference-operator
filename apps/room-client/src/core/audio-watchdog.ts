import { DB_FLOOR, type AudioAlert, type InputLevel } from '@conference-operator/contract'

/**
 * The capture watchdog: while a talk is recorded, does the microphone come in?
 *
 * A room whose microphone dies keeps the same projection, the same stopwatch and
 * the same red button: nothing on screen says the VOD has no voice — until it is
 * edited, days later. The levels OBS meters say it, so the room listens to them
 * while it records, even with nobody watching the VU meter.
 *
 * By samples rather than continuously: OBS meters fifty times a second, on the
 * machine that encodes. Five seconds every thirty are enough for what is
 * watched here — a microphone dead for a minute, not a syllable lost.
 *
 * Pure: the room feeds it the time, the context and the levels, and reads back
 * whether it wants to listen and what it heard wrong.
 */

export interface WatchdogSettings {
  /** Between the starts of two samples. */
  everyMs: number
  /** How long a sample listens. */
  forMs: number
  /**
   * Below this, a sample is silent (dBFS, the loudest moment of the sample). A
   * lapel microphone with nobody talking still hears the room, well above it.
   */
  silenceDb: number
  /** Consecutive silent samples before the alert: one pause is not a dead mic. */
  silentSamples: number
  /** At or above this, a peak clips (dBFS) — the VOD's true-peak ceiling. */
  clipDb: number
}

export const DEFAULT_WATCHDOG: WatchdogSettings = {
  everyMs: 30_000,
  forMs: 5_000,
  silenceDb: -50,
  silentSamples: 2,
  clipDb: -1,
}

/** What the room knows, at each tick. */
export interface WatchdogContext {
  /** OBS-B records, and a talk runs: the only moment a dead mic costs a VOD. */
  active: boolean
  /** The sources listened to, and whether OBS-B mutes them. */
  inputs: { name: string; muted: boolean }[]
}

interface Heard {
  magnitude: number
  peak: number
}

export class AudioWatchdog {
  #active = false
  /** The current sample's start, or `null` between two samples. */
  #sampleStart: number | null = null
  #nextSample = 0
  #heard = new Map<string, Heard>()
  #silentRuns = new Map<string, number>()
  /** Alerts by `kind:input`, with when they started. */
  #alerts = new Map<string, AudioAlert>()
  #watched = new Set<string>()

  constructor(
    private readonly onChange: (alerts: AudioAlert[]) => void,
    private readonly settings: WatchdogSettings = DEFAULT_WATCHDOG,
  ) {}

  /** Whether the room should have OBS meter now: a sample is under way. */
  listening(): boolean {
    return this.#sampleStart != null
  }

  alerts(): AudioAlert[] {
    return [...this.#alerts.values()]
  }

  /** The levels OBS sent, raw: only those of a sample, of a watched source, count. */
  push(levels: InputLevel[]): void {
    if (this.#sampleStart == null) return
    for (const level of levels) {
      if (!this.#watched.has(level.name)) continue
      const loudest = level.channels.reduce(
        (max, channel) => ({ magnitude: Math.max(max.magnitude, channel.magnitude), peak: Math.max(max.peak, channel.peak) }),
        { magnitude: DB_FLOOR, peak: DB_FLOOR },
      )
      const before = this.#heard.get(level.name)
      this.#heard.set(level.name, before == null
        ? loudest
        : { magnitude: Math.max(before.magnitude, loudest.magnitude), peak: Math.max(before.peak, loudest.peak) })
    }
  }

  /** Called every second or so. */
  tick(nowMs: number, context: WatchdogContext): void {
    if (!context.active) {
      if (this.#active) this.#stop()
      return
    }
    if (!this.#active) {
      this.#active = true
      this.#nextSample = nowMs
    }
    this.#watched = new Set(context.inputs.map((input) => input.name))
    const next = new Map<string, AudioAlert>()
    const keep = (kind: AudioAlert['kind'], input: string) => {
      const key = `${kind}:${input}`
      next.set(key, this.#alerts.get(key) ?? { kind, input, since: new Date(nowMs).toISOString() })
    }

    // Muted: no need to listen, OBS says it.
    for (const input of context.inputs) if (input.muted) keep('muet', input.name)

    if (this.#sampleStart == null && nowMs >= this.#nextSample) {
      this.#sampleStart = nowMs
      this.#heard.clear()
    }
    const sampleEnded = this.#sampleStart != null && nowMs - this.#sampleStart >= this.settings.forMs
    for (const input of context.inputs) {
      if (input.muted) {
        this.#silentRuns.delete(input.name)
        continue
      }
      const key = (kind: AudioAlert['kind']) => `${kind}:${input.name}`
      if (!sampleEnded) {
        // Between two verdicts, what was heard last still stands.
        for (const kind of ['silence', 'saturation'] as const) if (this.#alerts.has(key(kind))) keep(kind, input.name)
        continue
      }
      const heard = this.#heard.get(input.name)
      // Nothing at all from OBS for this source: unknown, not silent — say nothing new.
      if (heard == null) {
        for (const kind of ['silence', 'saturation'] as const) if (this.#alerts.has(key(kind))) keep(kind, input.name)
        continue
      }
      const runs = heard.magnitude <= this.settings.silenceDb ? (this.#silentRuns.get(input.name) ?? 0) + 1 : 0
      this.#silentRuns.set(input.name, runs)
      if (runs >= this.settings.silentSamples) keep('silence', input.name)
      if (heard.peak >= this.settings.clipDb) keep('saturation', input.name)
    }
    if (sampleEnded) {
      this.#nextSample = this.#sampleStart! + this.settings.everyMs
      this.#sampleStart = null
    }
    this.#set(next)
  }

  #stop(): void {
    this.#active = false
    this.#sampleStart = null
    this.#heard.clear()
    this.#silentRuns.clear()
    this.#set(new Map())
  }

  #set(next: Map<string, AudioAlert>): void {
    const same = next.size === this.#alerts.size && [...next.keys()].every((key) => this.#alerts.has(key))
    this.#alerts = next
    if (!same) this.onChange(this.alerts())
  }
}

/**
 * The sources to listen to: the one the room's settings name, if OBS-B has it;
 * otherwise every capture device (microphones, sound cards) — not the desktop
 * audio nor a media file, which may well be silent on purpose.
 */
export function watchedInputs(
  sources: { name: string; muted: boolean; capture?: boolean }[],
  named: string | null,
): { name: string; muted: boolean }[] {
  if (named != null) {
    const source = sources.find((candidate) => candidate.name === named)
    return source == null ? [] : [{ name: source.name, muted: source.muted }]
  }
  return sources.filter((source) => source.capture === true).map(({ name, muted }) => ({ name, muted }))
}
