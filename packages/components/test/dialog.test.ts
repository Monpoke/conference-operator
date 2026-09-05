import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import Dialog from '../src/ui/Dialog.vue'

/**
 * What closes a dialog, and what must not.
 *
 * The room machine is the reason for the rule. Its screen is touched, in the
 * dark, beside a talk in progress: a settings panel half filled in must not go
 * away because a sleeve brushed the overlay — and the click behind it lands on
 * the LIVE and HOLD buttons.
 */
const Host = defineComponent({
  setup: () => ({ open: ref(true) }),
  render() {
    return h(
      Dialog,
      {
        open: this.open,
        'onUpdate:open': (value: boolean) => (this.open = value),
        title: 'Configuration de la salle',
      },
      { default: () => h('input', { 'data-role': 'field' }) },
    )
  },
})

const press = (node: Element | Document, type: string): void => {
  node.dispatchEvent(new PointerEvent(type, { bubbles: true }))
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('Dialog', () => {
  it('stays open when the panel itself is used', async () => {
    const wrapper = mount(Host, { attachTo: document.body })
    await flushPromises()

    press(document.querySelector('[data-role="field"]')!, 'pointerdown')
    await flushPromises()

    expect(wrapper.vm.open).toBe(true)
    wrapper.unmount()
  })

  it('stays open when what is outside it is pressed', async () => {
    const wrapper = mount(Host, { attachTo: document.body })
    await flushPromises()

    // The overlay, and anything the overlay does not cover: both are outside, and
    // neither is an answer to the question the panel is asking.
    press(document.body, 'pointerdown')
    press(document.body, 'pointerup')
    await flushPromises()

    expect(wrapper.vm.open).toBe(true)
    wrapper.unmount()
  })

  it('closes on Escape, and on the Fermer button', async () => {
    const wrapper = mount(Host, { attachTo: document.body })
    await flushPromises()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(wrapper.vm.open).toBe(false)

    wrapper.vm.open = true
    await flushPromises()
    const close = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Fermer',
    )
    expect(close).toBeDefined()
    close!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(wrapper.vm.open).toBe(false)
    wrapper.unmount()
  })
})
