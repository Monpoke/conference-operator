import { CONSOLE_THEME_KEY } from '@conference-operator/contract'
import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Dark or light, on this device.
 *
 * The console is carried on a laptop from the régie to a lit room, and a dark
 * screen in daylight is one to squint at. The setting is the device's, like the
 * notifications': the laptop in the foyer and the one in the dark control room
 * have two legitimate answers.
 *
 * Dark stays the default, and anything unreadable reads as dark — the theme the
 * rest of the event's screens are drawn in.
 */
export type Theme = 'dark' | 'light'

export function readTheme(storage: Storage | undefined = globalThis.localStorage): Theme {
  try {
    return storage?.getItem(CONSOLE_THEME_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/**
 * The attribute the light palette hangs on (`apps.css`).
 *
 * Removed rather than set to `dark`: the absence of the attribute is the dark
 * theme, so there is only one way of being dark.
 */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme === 'light') root.dataset.theme = 'light'
  else delete root.dataset.theme
}

export const useThemeStore = defineStore('theme', () => {
  const theme = ref<Theme>(readTheme())
  applyTheme(theme.value)

  function toggle(): void {
    theme.value = theme.value === 'light' ? 'dark' : 'light'
    applyTheme(theme.value)
    try {
      globalThis.localStorage?.setItem(CONSOLE_THEME_KEY, theme.value)
    } catch {
      // Private browsing, storage full: the theme holds until the next load.
    }
  }

  return { theme, toggle }
})
