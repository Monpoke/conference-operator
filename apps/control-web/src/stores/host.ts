import type { HostLoad } from '@conference-operator/contract'
import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * One reading every five seconds, and not one more field in the stream.
 *
 * The measurement is already an average over its interval: polling more often
 * would say nothing more. Above all, a room whose control window is closed thus
 * goes on emitting no traffic — it is the only traffic from a room at rest we
 * agreed to add, and it stops with the window.
 */
export const POLL_MS = 5000

/**
 * The machine's load, read outside the state stream.
 *
 * `null` covers two cases the view tells apart: the local server did not answer,
 * or it answered with no measurement — the first window has not elapsed yet.
 * Confusing them would make a machine that has just started look like one that
 * no longer answers.
 */
export const useHostStore = defineStore('host', () => {
  const load = ref<HostLoad | null>(null)

  let timer: ReturnType<typeof setInterval> | null = null

  async function refresh(): Promise<void> {
    try {
      const response = await fetch('/control/host')
      if (!response.ok) throw new Error('relevé indisponible')
      load.value = (await response.json()) as HostLoad
    } catch {
      load.value = null
    }
  }

  function start(): void {
    if (timer != null) return
    void refresh()
    timer = setInterval(() => void refresh(), POLL_MS)
  }

  function stop(): void {
    if (timer == null) return
    clearInterval(timer)
    timer = null
  }

  return { load, refresh, start, stop }
})
