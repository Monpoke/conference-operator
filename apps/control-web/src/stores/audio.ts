import { DB_FLOOR, type InputLevel } from '@cloudnord/contract'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { StateStream } from './room.js'

/**
 * Peak hold.
 *
 * A tenth-of-a-second clip must stay readable: with no hold it slips between two
 * renders and nobody ever sees it.
 */
export const PEAK_HOLD_MS = 1500

interface Peak {
  db: number
  until: number
}

/**
 * Audio levels, on a stream separate from the state.
 *
 * Separate for two reasons: the cadence — ten messages a second against a few an
 * hour for the state — and the fact that only the control app uses them. Closing
 * the page is enough to cut the subscription on OBS.
 */
export const useAudioStore = defineStore('audio', () => {
  const inputs = ref<InputLevel[]>([])
  /** True while no message has arrived: "waiting" is not "none". */
  const waiting = ref(true)

  const peaks = ref<Record<string, Peak>>({})
  let stream: StateStream | null = null

  function apply(entries: InputLevel[], atMs: number): void {
    waiting.value = false
    inputs.value = entries
    const held: Record<string, Peak> = {}
    for (const entry of entries) {
      const top = entry.channels.reduce((max, channel) => Math.max(max, channel.peak), DB_FLOOR)
      const previous = peaks.value[entry.name]
      held[entry.name] =
        previous == null || top >= previous.db || atMs > previous.until
          ? { db: top, until: atMs + PEAK_HOLD_MS }
          : previous
    }
    peaks.value = held
  }

  function connect(open: (url: string) => StateStream = (url) => new EventSource(url)): void {
    if (stream != null) return
    stream = open('/display/audio')
    stream.onmessage = (event) => {
      apply((JSON.parse(event.data) as { inputs: InputLevel[] }).inputs, Date.now())
    }
  }

  function disconnect(): void {
    stream?.close()
    stream = null
  }

  return { inputs, waiting, peaks, apply, connect, disconnect }
})
