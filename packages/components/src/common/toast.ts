import { ref, type Ref } from 'vue'

/**
 * One place that says what just happened.
 *
 * There were three of these: the console's `avis()` at 3800 ms, the wall's at
 * 4000 ms with a different set of class names, and the room control's `toast()`
 * at 3200 ms. None of the divergences had a reason, and none of the three said
 * anything to a screen reader.
 *
 * A queue rather than a replacement, which is the behaviour change worth
 * noticing: two failures in a row used to show one message, and the operator
 * saw the second one only.
 */
export interface Notice {
  id: number
  text: string
  failed: boolean
}

/** How long a notice stays. One duration, since none of the three differed on purpose. */
export const NOTICE_MS = 3_500

let nextId = 0

const queue: Ref<Notice[]> = ref([])

function push(text: string, failed: boolean): void {
  const id = (nextId += 1)
  queue.value = [...queue.value, { id, text, failed }]
  setTimeout(() => {
    queue.value = queue.value.filter((notice) => notice.id !== id)
  }, NOTICE_MS)
}

/**
 * Module scope on purpose, unlike the stores.
 *
 * A notice is not application state: nothing derives from it, nothing reloads
 * it, and it must be raisable from a place that has no component instance —
 * the hub client's error hook, for one.
 */
export function useToast(): {
  notices: Ref<Notice[]>
  say: (text: string) => void
  fail: (text: string) => void
  clear: () => void
} {
  return {
    notices: queue,
    say: (text) => push(text, false),
    fail: (text) => push(text, true),
    clear: () => {
      queue.value = []
    },
  }
}
