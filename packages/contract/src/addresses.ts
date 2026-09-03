/**
 * The console's addresses — one per tab.
 *
 * They live in the contract because two sides need the exact same list and
 * neither can own it: the hub enumerates them to register its routes, and the
 * console's router declares them to navigate. Putting them in the console would
 * force the hub to depend on it — and drag Vue into the server image; putting
 * them in the hub would force the console to depend on a Fastify package.
 *
 * The hub registers **one route per view** rather than a `/admin/*` wildcard,
 * on purpose: an unknown view must answer 404, not silently render a console
 * with no tab selected. A test pins that.
 */

/**
 * Views, in tab order.
 *
 * `developpement` exists in dev mode only — the console does not render it and
 * the hub does not serve its address: a hidden view is one `hidden` attribute
 * away from whoever opens the inspector. In a bundle the same reasoning applies
 * to its module, which the router must import lazily rather than statically.
 */
export function consoleViews(dev: boolean): string[] {
  const views = ['exploitation', 'appairage', 'conferences', 'moderation', 'messages', 'vod', 'reglages']
  return dev ? [...views, 'developpement'] : views
}

/**
 * A view's address.
 *
 * Operations lives at the root: it is the default view, and `/admin` is the
 * address people type from memory or bookmark.
 */
export function viewPath(view: string): string {
  return view === 'exploitation' ? '/admin' : `/admin/${view}`
}

/**
 * The pairing address Better Auth imposes.
 *
 * It is the one handed to machines (`/admin/devices?user_code=…`): it does not
 * get renamed, it gets added. It opens the same view as `/admin/appairage`.
 *
 * For a router this is an **alias**, never a redirect: rewriting the URL would
 * drop the `user_code` the operator is about to approve, which is the whole
 * reason somebody followed the link.
 */
export const PAIRING_ALIAS = '/admin/devices'

/**
 * The pairing alias travels with the view it opens.
 *
 * `/admin/devices` is not a view of its own — it is a second door onto
 * `appairage`, and it has to open on the same handler. A door left on another
 * one would send every machine Better Auth redirects to a page that cannot read
 * the code it arrives with, and only the machines: an operator clicking the tab
 * would never see it.
 */
function aliasPaths(view: string): string[] {
  return view === 'appairage' ? [PAIRING_ALIAS] : []
}

/** Every address the hub serves from the console bundle, given the mode. */
export function consolePaths(dev: boolean): string[] {
  return consoleViews(dev).flatMap((view) => [viewPath(view), ...aliasPaths(view)])
}

/**
 * The control app, served twice.
 *
 * The room machine serves it for its own room (`/regie`, nothing more); the hub
 * serves it for any room (`/regie` = pick one, `/regie/<id>` = drive it). Same
 * bundle, same Vite `base`, two hosts — hence these three functions here rather
 * than in either of them: the hub enumerates them to register its routes, the
 * application reads them to navigate, and neither can depend on the other.
 *
 * The path itself stays `/regie`: it is bookmarked, and it is what an operator
 * types from memory.
 */
export const CONTROL_PATH = '/regie'

/** A room's address, or that of the picker screen. */
export function controlPath(roomId: string | null): string {
  return roomId == null ? CONTROL_PATH : `${CONTROL_PATH}/${encodeURIComponent(roomId)}`
}

/**
 * The room an address designates, or `null` for the picker screen.
 *
 * Returns `null` too for anything that is not a control address: called on
 * `/admin`, it must not invent a room named `admin`.
 */
export function controlRoomIdFromPath(pathname: string): string | null {
  if (pathname === CONTROL_PATH || pathname === `${CONTROL_PATH}/`) return null
  const prefix = `${CONTROL_PATH}/`
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length)
  /*
   * A single segment, and not a wildcard.
   *
   * `/regie/track-1/assets/x.js` is an asset request, not a room named
   * `track-1/assets`. The hub serves assets under this prefix, and confusing the
   * two would render the shell in place of a module.
   */
  if (rest === '' || rest.includes('/')) return null
  return decodeURIComponent(rest)
}
