import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import ConfirmDialog from '../src/ui/ConfirmDialog.vue'

/**
 * The two answers, from the keyboard.
 *
 * In a dark room, aiming at a button costs more than pressing a key: that is the
 * reason for the single-letter shortcuts throughout the control app, and a
 * question that interrupts a talk is where it matters most.
 *
 * The letters used to be **labels**, bound by whoever mounted the dialog. Two
 * questions out of four had them, so two out of four answered the keyboard, and
 * nothing on screen told them apart. They are now printed and bound in the same
 * place: they can no longer diverge.
 */

/** Reka's portal renders outside the component: the document is what we read. */
const mountDialog = (props: Record<string, unknown> = {}) =>
  mount(ConfirmDialog, {
    props: { open: true, title: 'Terminer en avance ?', confirmLabel: 'Terminer', ...props },
    attachTo: document.body,
  })

const press = (key: string, options: KeyboardEventInit = {}): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...options }))
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ConfirmDialog from the keyboard', () => {
  it('prints Y and N without being asked', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    // A dialog that is deaf to the keyboard and one that answers looked exactly
    // alike: the defect is what brought them together.
    expect(document.body.textContent).toContain('Y')
    expect(document.body.textContent).toContain('N')
    wrapper.unmount()
  })

  it('confirms on "y", and closes as a click would', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    press('y')
    await flushPromises()

    expect(wrapper.emitted('confirm')).toHaveLength(1)
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
    wrapper.unmount()
  })

  it('accepts "o" as readily as "y"', async () => {
    // Half the operators type one, the other half the other, and getting the
    // letter wrong on that question costs a talk.
    const wrapper = mountDialog()
    await flushPromises()

    press('o')
    await flushPromises()

    expect(wrapper.emitted('confirm')).toHaveLength(1)
    wrapper.unmount()
  })

  it('closes on "n" without confirming anything', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    press('n')
    await flushPromises()

    expect(wrapper.emitted('confirm')).toBeUndefined()
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
    wrapper.unmount()
  })

  it('leaves to the browser what is held with Ctrl, Cmd or Alt', async () => {
    // `Ctrl+N` opens a window: reading the letter alone would cancel the question
    // along the way, and nothing on screen would say where it came from.
    const wrapper = mountDialog()
    await flushPromises()

    press('n', { ctrlKey: true })
    press('y', { metaKey: true })
    press('y', { altKey: true })
    await flushPromises()

    expect(wrapper.emitted('confirm')).toBeUndefined()
    expect(wrapper.emitted('update:open')).toBeUndefined()
    wrapper.unmount()
  })

  it('leaves the field the keystroke meant for it', async () => {
    /*
     * The reset dialog arms its button by making you type a word. A letter typed
     * in there must not answer the question behind it — and a `<select>` counts
     * as much as a text field.
     */
    const wrapper = mountDialog()
    await flushPromises()
    const field = document.createElement('input')
    document.body.appendChild(field)

    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', bubbles: true }))
    await flushPromises()

    expect(wrapper.emitted('confirm')).toBeUndefined()
    wrapper.unmount()
  })

  it('does not get around a disarmed button', async () => {
    // The key is the button, not a way past it.
    const wrapper = mountDialog({ confirmDisabled: true })
    await flushPromises()

    press('y')
    await flushPromises()

    expect(wrapper.emitted('confirm')).toBeUndefined()
    expect(wrapper.emitted('update:open')).toBeUndefined()
    wrapper.unmount()
  })

  it('neither prints nor binds anything when the letter is removed', async () => {
    const wrapper = mountDialog({ confirmKey: null, cancelKey: null })
    await flushPromises()

    press('y')
    press('n')
    await flushPromises()

    expect(wrapper.emitted('confirm')).toBeUndefined()
    expect(wrapper.emitted('update:open')).toBeUndefined()
    wrapper.unmount()
  })

  it('stays deaf once closed', async () => {
    // The listener lives with the component, not with the opening: without this
    // test, a closed dialog would still answer the keyboard of the page behind.
    const wrapper = mountDialog({ open: false })
    await flushPromises()

    press('y')
    await flushPromises()

    expect(wrapper.emitted('confirm')).toBeUndefined()
    wrapper.unmount()
  })
})
