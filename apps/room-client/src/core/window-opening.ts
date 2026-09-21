/**
 * Where a link opened from the control app should land.
 *
 * The control app is a web page inside Electron, and every `target="_blank"` in
 * it used to become another Electron window. That is right for the room's own
 * screens — overlays, live banner, public wall — which belong to the machine and
 * are served by it. It is wrong for the pairing address: the operator clicks the
 * hub's link to approve the machine, and got a bare Electron window with no
 * address bar, no history and no session — the console's login is in *their*
 * browser, not in the room's shell. That link belongs in the default browser.
 *
 * The decision is taken here, away from Electron, so it can be exercised without
 * a screen.
 */
export type WindowOpening =
  /** The projection, placed on the video projector output by the caller. */
  | 'projector'
  /** One of the machine's own screens: an ordinary Electron window. */
  | 'window'
  /** Anything else on the web: the operator's default browser. */
  | 'browser'
  /**
   * Neither: a scheme that is not the web.
   *
   * Handing an arbitrary scheme to the system would let a page the machine did
   * not write start whatever is registered for it. Nothing in the control app
   * opens one, so refusing costs nothing.
   */
  | 'refuse'

export function decideOpening(url: string, localOrigin: string): WindowOpening {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return 'refuse'
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return 'refuse'
  if (!sameOrigin(target, localOrigin)) return 'browser'
  return target.pathname === '/display/projector' ? 'projector' : 'window'
}

function sameOrigin(target: URL, localOrigin: string): boolean {
  try {
    return target.origin === new URL(localOrigin).origin
  } catch {
    return false
  }
}
