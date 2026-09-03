import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * The one-second beat, kept in a single place.
 *
 * Five displays depend on it — the clock, the slot countdown, the take
 * stopwatch, the expiry of notices, the detection of a dead stream — and each
 * held its own `setInterval` in the original page. Five wake-ups a second on a
 * machine that encodes, for five reads of the same value.
 *
 * A store rather than a module: a module-scoped `ref` would survive from one
 * test file to the next, along with its interval, and the defect would only show
 * up under parallel execution.
 */
export const useClockStore = defineStore('clock', () => {
  /** The machine's real time. The hub's offset is added by whoever displays it. */
  const real = ref(Date.now())

  let timer: ReturnType<typeof setInterval> | null = null

  function start(): void {
    if (timer != null) return
    timer = setInterval(() => {
      real.value = Date.now()
    }, 1000)
  }

  function stop(): void {
    if (timer == null) return
    clearInterval(timer)
    timer = null
  }

  /** Advances the beat by hand. Reserved for tests, which do not sleep. */
  function advance(ms: number): void {
    real.value += ms
  }

  return { real, start, stop, advance }
})
