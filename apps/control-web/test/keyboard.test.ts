import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useKeyboardLayer, useKeyboardStore } from '../src/stores/keyboard.js'

/**
 * The shortcuts, and what they cost when they fire at the wrong moment.
 *
 * Two of them switch the projection in front of an audience, a third starts a
 * take. This file exists ahead of the control app's first modal, and deliberately
 * so: the original page's protection — reading `tagName`, reading six attributes
 * on the `<body>` — does not survive modals that write nothing on the `<body>` and
 * whose dropdowns are `<button>` elements.
 */

/**
 * A keystroke reduced to what the rules read.
 *
 * `Record<string, unknown>` rather than `Partial<KeyboardEvent>`: a target here is
 * only a `tagName` and a flag, and pretending to give it an `EventTarget`'s
 * surface would mean building an element per case to check nothing more.
 */
function press(key: string, extras: Record<string, unknown> = {}): KeyboardEvent {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target: { tagName: 'BODY', isContentEditable: false },
    preventDefault: () => {},
    ...extras,
  } as unknown as KeyboardEvent
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('what belongs to the browser', () => {
  it('lets Ctrl, Cmd and Alt through without firing anything', () => {
    const keyboard = useKeyboardStore()
    const fired: string[] = []
    keyboard.push(() => ({ r: () => fired.push('rec') }))

    for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
      keyboard.handle(press('r', { [modifier]: true }))
    }

    /*
     * Ctrl+R reloads the page — and used to start the take along the way, since
     * only the letter was read. A control app found recording with nobody having
     * asked for it, and nothing on screen to say where it came from.
     */
    expect(fired).toEqual([])
  })

  it('lets Shift through, because it is not a browser shortcut', () => {
    const keyboard = useKeyboardStore()
    const fired: string[] = []
    keyboard.push(() => ({ r: () => fired.push('rec') }))

    // "Shift+R" means nothing to the browser, and it is the same intent as "r"
    // for somebody typing fast.
    keyboard.handle(press('R', { shiftKey: true }))

    expect(fired).toEqual(['rec'])
  })
})

describe('what belongs to a field', () => {
  it.each(['INPUT', 'SELECT', 'TEXTAREA'])('does not steal a %s\'s keystroke', (tag) => {
    const keyboard = useKeyboardStore()
    const fired: string[] = []
    keyboard.push(() => ({ l: () => fired.push('live') }))

    // Dropdowns count as much as text fields: an "l" in a scene picker must not
    // switch the projection live.
    keyboard.handle(press('l', { target: { tagName: tag } }))

    expect(fired).toEqual([])
  })

  it('does not steal an editable content\'s keystroke', () => {
    const keyboard = useKeyboardStore()
    const fired: string[] = []
    keyboard.push(() => ({ l: () => fired.push('live') }))

    keyboard.handle(press('l', { target: { tagName: 'DIV', isContentEditable: true } }))

    expect(fired).toEqual([])
  })
})

describe('stacking', () => {
  it('serves only the top layer', () => {
    const keyboard = useKeyboardStore()
    const fired: string[] = []
    keyboard.push(() => ({ l: () => fired.push('live') }))
    keyboard.push(() => ({ y: () => fired.push('yes') }))

    keyboard.handle(press('y'))

    expect(fired).toEqual(['yes'])
  })

  it('swallows what it has not bound, instead of letting it fall through', () => {
    const keyboard = useKeyboardStore()
    const fired: string[] = []
    keyboard.push(() => ({ r: () => fired.push('rec') }))
    keyboard.push(() => ({ y: () => fired.push('yes') }))

    keyboard.handle(press('r'))

    /*
     * An open question takes the whole keyboard. A reflex "r" while being asked
     * whether to record would switch the take underneath the question itself — and
     * that is the gesture one cannot undo.
     */
    expect(fired).toEqual([])
  })

  it('gives the keyboard back to the layer below when the top one leaves', () => {
    const keyboard = useKeyboardStore()
    const fired: string[] = []
    keyboard.push(() => ({ r: () => fired.push('rec') }))
    const question = keyboard.push(() => ({ y: () => fired.push('yes') }))

    keyboard.pop(question)
    keyboard.handle(press('r'))

    expect(fired).toEqual(['rec'])
  })

  it('pops the right layer, even when they close out of order', () => {
    const keyboard = useKeyboardStore()
    const fired: string[] = []
    const lower = keyboard.push(() => ({ r: () => fired.push('rec') }))
    keyboard.push(() => ({ y: () => fired.push('yes') }))

    // Two stacked modals, and it is the lower one that closes first: the control
    // app layers the recordings list over the program.
    keyboard.pop(lower)
    keyboard.handle(press('y'))

    expect(fired).toEqual(['yes'])
    expect(keyboard.depth()).toBe(1)
  })

  it('does nothing when nobody is listening any more', () => {
    const keyboard = useKeyboardStore()
    const id = keyboard.push(() => ({ r: () => {} }))
    keyboard.pop(id)

    expect(() => keyboard.handle(press('r'))).not.toThrow()
    expect(keyboard.depth()).toBe(0)
  })
})

describe('real wiring', () => {
  it('listens to the document while a layer is laid down, and not after', () => {
    const keyboard = useKeyboardStore()
    const fired: string[] = []
    const id = keyboard.push(() => ({ l: () => fired.push('live') }))

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }))
    expect(fired).toEqual(['live'])

    keyboard.pop(id)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }))

    // A listener left on the document after the last layer is a shortcut firing
    // from a page where nothing is expecting it any more.
    expect(fired).toEqual(['live'])
  })
})

describe('layer tied to a component', () => {
  it('is laid down and removed with the scope that holds it', () => {
    const keyboard = useKeyboardStore()
    const fired: string[] = []
    const scope = effectScope()

    scope.run(() => {
      useKeyboardLayer({ l: () => fired.push('live') })
    })
    expect(keyboard.depth()).toBe(1)

    scope.stop()

    // A layer that outlives its modal is the worst of both worlds: it swallows the
    // shortcuts of a page that has nothing open any more.
    expect(keyboard.depth()).toBe(0)
  })

  it('waits for the opening, rather than the mount', async () => {
    const keyboard = useKeyboardStore()
    const open = ref(false)
    const scope = effectScope()

    scope.run(() => {
      useKeyboardLayer({ y: () => {} }, open)
    })

    // Reka often renders the content before opening it: a layer laid down at mount
    // time would steal the keys from the page behind.
    expect(keyboard.depth()).toBe(0)

    open.value = true
    await nextTick()
    expect(keyboard.depth()).toBe(1)

    open.value = false
    await nextTick()
    expect(keyboard.depth()).toBe(0)
    scope.stop()
  })

  it('reads its bindings back on every keystroke, not once and for all', () => {
    const keyboard = useKeyboardStore()
    const fired: string[] = []
    const target = ref('live')
    const scope = effectScope()

    scope.run(() => {
      useKeyboardLayer(() => ({ l: () => fired.push(target.value) }))
    })

    keyboard.handle(press('l'))
    target.value = 'hold'
    keyboard.handle(press('l'))

    // The talk being driven changes during the day: a binding frozen at opening
    // time would act on the previous one.
    expect(fired).toEqual(['live', 'hold'])
    scope.stop()
  })
})
