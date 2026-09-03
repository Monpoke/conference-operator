import type { EventIdentity, ExecutionMode } from '@cloudnord/contract'

/**
 * What the hub tells the console before its first request.
 *
 * The same three things the string template interpolated, for the same reasons:
 * the event's name is the first word an operator reads and must not wait for a
 * round trip; `mode` decides whether the development view exists at all, and
 * deciding that in the browser would put the code that moves everyone's clock
 * into the production bundle; and the Google button is only rendered when the
 * hub knows what to do with it, because offering a sign-in that fails on click
 * is worth less than offering nothing.
 */
export interface Boot {
  mode: ExecutionMode
  event: EventIdentity
  google: { domain: string } | null
}

/** Where the shell puts it. Kept in one place because two of them read it. */
export const BOOT_ELEMENT_ID = 'console-boot'

/**
 * Reads the payload, or fails loudly.
 *
 * No default. A console booted without knowing its mode would quietly render as
 * production — which is the safe direction, but it would also hide a broken
 * shell for as long as nobody looks for the development tab.
 */
export function readBoot(document: Document): Boot {
  const element = document.getElementById(BOOT_ELEMENT_ID)
  if (element == null || element.textContent == null || element.textContent.trim() === '') {
    throw new Error(
      `Coquille sans données d'amorçage : #${BOOT_ELEMENT_ID} est absent ou vide. ` +
        'La console est servie par le hub, qui les injecte au rendu.',
    )
  }
  return JSON.parse(element.textContent) as Boot
}
