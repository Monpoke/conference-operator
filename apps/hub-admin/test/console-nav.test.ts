import { VIEW_PERMISSIONS, viewPath } from '@conference-operator/contract'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ConsoleNav from '../src/components/ConsoleNav.vue'
import { createConsoleRouter } from '../src/router.js'
import { useSessionStore } from '../src/stores/session.js'

/**
 * The tabs, on a phone: one line that scrolls sideways, the current tab kept
 * in view. The geometry is the browser's; what is tested is that the current
 * tab is the one brought into view, on arrival and on every change of view.
 */
beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the console tabs', () => {
  it('bring the current tab into view, on arrival and when the view changes', async () => {
    const shown: string[] = []
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) {
      shown.push(this.id)
    })
    const session = useSessionStore()
    session.permissions = new Set(Object.values(VIEW_PERMISSIONS).filter((p) => p != null) as string[])

    const router = createConsoleRouter()
    await router.push(viewPath('journal'))
    const wrapper = mount(ConsoleNav, { global: { plugins: [router] }, attachTo: document.body })
    await flushPromises()

    expect(wrapper.get('[aria-current="page"]').attributes('id')).toBe('nav-journal')
    expect(shown.at(-1)).toBe('nav-journal')

    await router.push(viewPath('moderation'))
    await flushPromises()

    expect(shown.at(-1)).toBe('nav-moderation')
    wrapper.unmount()
  })
})
