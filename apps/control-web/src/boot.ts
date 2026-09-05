import type { DisplayPayload } from '@conference-operator/contract'

/**
 * The room's state, embedded in the shell.
 *
 * The room machine renders the page with its complete state inside it, and that
 * is this module's only reason for being. A reload of the control app almost
 * always comes at the worst moment — the window has frozen, the operator hits F5
 * during the talk. Waiting for the stream's first message to paint anything
 * would give half a second of blank screen at that very instant.
 *
 * Absent in development, where `vite dev` serves `index.html` as is: the page
 * then fills up when the stream opens, which is the degraded behaviour accepted
 * outside a room.
 */
export const BOOT_ELEMENT_ID = 'etat-initial'

export function readInitialPayload(document: Document): DisplayPayload | null {
  const element = document.getElementById(BOOT_ELEMENT_ID)
  const content = element?.textContent
  if (content == null || content.trim() === '') return null
  return JSON.parse(content) as DisplayPayload
}

/**
 * Where the control app is served from, and for which room.
 *
 * Two hosts serve the same bundle: the room machine, which has only one room and
 * knows it, and the hub, which has them all and waits for one to be chosen. That
 * is the only thing the application needs to know before mounting — the rest
 * follows from the transport it picks.
 *
 * **Absence means "locale".** That is what a room machine serves, and also what
 * `vite dev` serves with its bare `index.html`: the default is the case where
 * nobody has anything to say.
 *
 * `portee`, `salles` and the two element ids are the boot contract shared with
 * `hub-server` and `room-client`: they are not renamed.
 */
export const SCOPE_ELEMENT_ID = 'regie-portee'

export interface BootScope {
  portee: 'locale' | 'distante'
  /** The room being driven, or `null` for the choice screen. */
  roomId: string | null
  /** The known rooms, laid down before any network call. */
  salles: { id: string; name: string }[]
  /** The Google domain, or `null`: the button only appears if the hub serves it. */
  google: { domain: string } | null
}

const LOCALE: BootScope = { portee: 'locale', roomId: null, salles: [], google: null }

export function readScope(document: Document): BootScope {
  const content = document.getElementById(SCOPE_ELEMENT_ID)?.textContent
  if (content == null || content.trim() === '') return LOCALE
  try {
    return { ...LOCALE, ...(JSON.parse(content) as Partial<BootScope>) }
  } catch {
    /*
     * An unreadable boot payload falls back to local, and breaks nothing.
     *
     * It is the only safe choice: a page that refuses to mount because a JSON
     * blob is truncated leaves a black screen where a control app was expected.
     */
    return LOCALE
  }
}
