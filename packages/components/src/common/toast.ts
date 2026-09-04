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
  /**
   * The group this notice speaks for, when it has one.
   *
   * Two notices sharing a group never coexist: the later one takes the earlier
   * one's place. See `push`.
   */
  key?: string
}

/** What a notice can be given beyond its text. */
export interface NoticeOptions {
  /**
   * Say this in place of the last notice carrying the same key.
   *
   * The queue is right for facts that each happened once — two OBS instances
   * failing is two facts. It is wrong for a gesture one repeats while hunting
   * for a shot: "Scène : LIVE", "Scène : HOLD", "Scène : LIVE" is one fact
   * stated three times, and it ends up as three rectangles piled in front of an
   * operator who is watching the room. Keyed, only the last one is left, on a
   * fresh clock.
   */
  key?: string
}

/** How long a notice stays. One duration, since none of the three differed on purpose. */
export const NOTICE_MS = 3_500

let nextId = 0

const queue: Ref<Notice[]> = ref([])

/**
 * Takes a notice away — its time being up, or a click having said so.
 *
 * An unknown id is not an error: a notice dismissed a hair after its expiry is
 * the ordinary race, not a fault to report.
 */
function dismiss(id: number): void {
  queue.value = queue.value.filter((notice) => notice.id !== id)
}

function push(text: string, failed: boolean, options: NoticeOptions = {}): void {
  const id = (nextId += 1)
  const { key } = options
  // The replaced notice keeps its timer, which will find nothing to remove: the
  // removal filters on the id, and that id has already left the queue.
  const kept = key == null ? queue.value : queue.value.filter((notice) => notice.key !== key)
  queue.value = [...kept, { id, text, failed, key }]
  setTimeout(() => {
    dismiss(id)
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
  say: (text: string, options?: NoticeOptions) => void
  fail: (text: string, options?: NoticeOptions) => void
  dismiss: (id: number) => void
  clear: () => void
} {
  return {
    notices: queue,
    say: (text, options) => push(text, false, options),
    fail: (text, options) => push(text, true, options),
    dismiss,
    clear: () => {
      queue.value = []
    },
  }
}
