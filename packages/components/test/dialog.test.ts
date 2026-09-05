import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import Dialog from '../src/ui/Dialog.vue'

/**
 * A dialog one can actually use.
 *
 * Reka blocks the outside by switching off the pointer events of `<body>` and
 * switching them back on, layer by layer, for whatever declared itself the
 * blocking one. A `DialogContent` that opts out of that declaration is left with
 * the body's `none` — it renders, it is read, and it answers nothing. The room
 * saw it before the tests did: a settings panel that closed as soon as it was
 * touched, because the click was landing on the overlay behind it.
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
      { default: () => h('button', { 'data-role': 'field' }, 'Un champ') },
    )
  },
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('Dialog', () => {
  it('takes the pointer events its content needs to answer', async () => {
    const wrapper = mount(Host, { attachTo: document.body })
    await flushPromises()

    const content = document.querySelector('[role="dialog"]') as HTMLElement | null
    expect(content).not.toBeNull()
    // Explicitly `auto`, and not merely "not none": the body around it is `none`,
    // which anything without a value of its own inherits.
    expect(content!.style.pointerEvents).toBe('auto')
    expect(document.body.style.pointerEvents).toBe('none')

    wrapper.unmount()
  })

  it('closes on Escape and on the Fermer button', async () => {
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
    close!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(wrapper.vm.open).toBe(false)

    wrapper.unmount()
  })
})
