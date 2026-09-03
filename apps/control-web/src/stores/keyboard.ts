import { defineStore } from 'pinia'
import { onScopeDispose, ref, toValue, watchEffect, type MaybeRefOrGetter } from 'vue'

/** What a layer does with a key. The keys are lowercase. */
export type Bindings = Record<string, () => void>

interface Layer {
  id: number
  bindings: () => Bindings
}

/**
 * The shortcuts, in layers, and only one receives the keyboard.
 *
 * In a dark room, aiming at a button costs more than pressing a key: the control
 * app therefore has single-letter shortcuts, and two of them — `l` and `h` —
 * switch the projection live, in front of an audience.
 *
 * The original page protected itself by reading `event.target.tagName` and
 * consulting six `data-` attributes on the `<body>`. Neither defence survives
 * Reka: a modal writes nothing on the `<body>`, and a `SelectTrigger` is a
 * `<button>` — looking for "LIVE" in a scene list by typing `l` would switch the
 * projection, in the room, during a talk. That is why this mechanism exists
 * **before** the first modal, and not after.
 *
 * The rule is simple and without exception: a stacked layer receives everything,
 * and what it has not bound, it swallows. An open question takes the whole
 * keyboard — a reflex "r" while being asked whether to record cannot switch the
 * take underneath the question itself.
 */
export const useKeyboardStore = defineStore('keyboard', () => {
  const layers = ref<Layer[]>([])
  let nextId = 0
  let installed: ((event: KeyboardEvent) => void) | null = null

  /**
   * What the top layer does with the keystroke, or nothing.
   *
   * Exposed so the rules can be checked with no keyboard and no document: they
   * are what counts, not the path that reaches them.
   */
  function handle(event: KeyboardEvent): void {
    /*
     * A key held with Ctrl, Cmd or Alt belongs to the browser.
     *
     * Ctrl+R reloads the page — and used to start the take along the way, since
     * only the letter was read. A control app found recording with nobody having
     * asked for it, one more file on the disk, and nothing on screen to say where
     * it came from. Ctrl+S, Ctrl+P and Ctrl+L set the same trap on other letters.
     *
     * Shift stays through: "Shift+R" means nothing to the browser, and it is the
     * same intent as "r" for somebody typing fast.
     */
    if (event.ctrlKey || event.metaKey || event.altKey) return

    /*
     * A keystroke meant for a field belongs to that field.
     *
     * Dropdowns count as much as text fields: an `l` in a scene picker must not
     * switch the projection. That is also why the control app's lists stay native
     * `<select>` elements — replaced by a component built on `<button>`, they
     * would fall out of this net.
     */
    const target = event.target as { tagName?: string; isContentEditable?: boolean } | null
    if (target?.isContentEditable === true) return
    const tag = target?.tagName
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return

    const top = layers.value.at(-1)
    if (top == null) return

    const action = top.bindings()[event.key.toLowerCase()]
    // Nothing bound: the layer swallows it all the same. That is what stops an
    // open question letting a shortcut through to the talk.
    if (action == null) return
    event.preventDefault()
    action()
  }

  function push(bindings: () => Bindings): number {
    const id = nextId++
    layers.value.push({ id, bindings })
    if (installed == null && typeof document !== 'undefined') {
      installed = (event: KeyboardEvent) => handle(event)
      document.addEventListener('keydown', installed)
    }
    return id
  }

  function pop(id: number): void {
    layers.value = layers.value.filter((layer) => layer.id !== id)
    if (layers.value.length === 0 && installed != null && typeof document !== 'undefined') {
      document.removeEventListener('keydown', installed)
      installed = null
    }
  }

  /** The receiving layer, for the tests and for whatever wants to ask. */
  const depth = (): number => layers.value.length

  return { layers, handle, push, pop, depth }
})

/**
 * Lays down a shortcut layer for as long as a component lives.
 *
 * `active` lets a modal keep its component mounted without taking the keyboard:
 * Reka often renders the content before opening it, and a layer laid down at
 * mount time would steal the keys from the page behind.
 */
export function useKeyboardLayer(
  bindings: MaybeRefOrGetter<Bindings>,
  active: MaybeRefOrGetter<boolean> = true,
): void {
  const keyboard = useKeyboardStore()
  let id: number | null = null

  const sync = (): void => {
    const wanted = toValue(active)
    if (wanted && id == null) id = keyboard.push(() => toValue(bindings))
    else if (!wanted && id != null) {
      keyboard.pop(id)
      id = null
    }
  }

  // `watchEffect` runs immediately: the layer is laid down as soon as it is
  // called if it should be, and then follows what `active` becomes.
  watchEffect(sync)
  onScopeDispose(() => {
    if (id != null) keyboard.pop(id)
  })
}
