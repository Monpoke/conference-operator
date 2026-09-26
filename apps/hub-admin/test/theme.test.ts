import { CONSOLE_THEME_KEY } from '@conference-operator/contract'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyTheme, readTheme, useThemeStore } from '../src/stores/theme.js'

/**
 * The console's theme: dark unless this device asked for light.
 *
 * What is worth holding is the direction of every failure — unreadable storage,
 * an unknown value, a missing attribute all land on dark, the theme of the rest
 * of the event's screens.
 */

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  setActivePinia(createPinia())
})

describe('theme read from storage', () => {
  it('is dark when nothing was set', () => {
    expect(readTheme({ getItem: () => null } as unknown as Storage)).toBe('dark')
  })

  it('is dark on an unknown value', () => {
    expect(readTheme({ getItem: () => 'sepia' } as unknown as Storage)).toBe('dark')
  })

  it('is dark when storage refuses to be read', () => {
    const storage = {
      getItem: () => {
        throw new Error('SecurityError')
      },
    } as unknown as Storage
    expect(readTheme(storage)).toBe('dark')
  })
})

describe('theme applied to the page', () => {
  it('removes the attribute for dark, rather than setting it', () => {
    // The light palette hangs on `[data-theme="light"]`; its absence is the only
    // way of being dark.
    const root = document.createElement('html')
    applyTheme('light', root)
    expect(root.dataset.theme).toBe('light')
    applyTheme('dark', root)
    expect(root.hasAttribute('data-theme')).toBe(false)
  })

  it('switches, and remembers it on this device', () => {
    const store = useThemeStore()
    expect(store.theme).toBe('dark')

    store.toggle()
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem(CONSOLE_THEME_KEY)).toBe('light')

    store.toggle()
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    expect(localStorage.getItem(CONSOLE_THEME_KEY)).toBe('dark')
  })

  it('picks up the remembered theme at start', () => {
    localStorage.setItem(CONSOLE_THEME_KEY, 'light')
    expect(useThemeStore().theme).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})
