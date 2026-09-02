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
 * Views the console bundle has taken over.
 *
 * The migration boundary itself, and it lives here for the same reason the
 * addresses do: the hub reads it to decide which handler answers, and the
 * console's router reads it to decide between a route and a plain link. The hub
 * cannot import it from the console — that would pull Vue into the server
 * image, and the Dockerfile's whole shape exists to keep it out.
 *
 * Moving a view across is one entry. So is moving it back, which is what makes
 * this the only screen-by-screen migration in the project that is free: no
 * bridge, no shared state, and a rollback that fits on one line.
 */
export const MIGRATED_VIEWS: readonly string[] = [
  'exploitation',
  'appairage',
  'conferences',
  'moderation',
  'messages',
  'vod',
  'reglages',
  'developpement',
]

/** True when this view is served by the bundle rather than the string template. */
export function isMigratedView(view: string): boolean {
  return MIGRATED_VIEWS.includes(view)
}

/**
 * The pairing alias follows the view it opens.
 *
 * `/admin/devices` is not a view of its own — it is a second door onto
 * `appairage`. Leaving it on the string template after that view had moved
 * would send every machine Better Auth redirects to the page that no longer
 * knows how to read the code, and only the machines: an operator clicking the
 * tab would never see it.
 */
function aliasPaths(view: string): string[] {
  return view === 'appairage' ? [PAIRING_ALIAS] : []
}

/** Addresses the hub still serves from the string template, given the mode. */
export function legacyConsolePaths(dev: boolean): string[] {
  return consoleViews(dev)
    .filter((view) => !isMigratedView(view))
    .flatMap((view) => [viewPath(view), ...aliasPaths(view)])
}

/** Addresses the hub serves from the bundle, given the mode. */
export function bundledConsolePaths(dev: boolean): string[] {
  return consoleViews(dev)
    .filter(isMigratedView)
    .flatMap((view) => [viewPath(view), ...aliasPaths(view)])
}

/**
 * La régie, servie deux fois.
 *
 * Le poste de salle la sert pour sa propre salle (`/regie`, sans plus) ; le hub
 * la sert pour n'importe laquelle (`/regie` = choisir, `/regie/<id>` = piloter).
 * Le même bundle, la même `base` Vite, deux hôtes — d'où ces trois fonctions
 * ici plutôt que dans l'un des deux : le hub les énumère pour enregistrer ses
 * routes, l'application les lit pour naviguer, et aucun des deux ne peut
 * dépendre de l'autre.
 */
export const REGIE_PATH = '/regie'

/** L'adresse d'une salle, ou celle de l'écran de choix. */
export function regiePath(roomId: string | null): string {
  return roomId == null ? REGIE_PATH : `${REGIE_PATH}/${encodeURIComponent(roomId)}`
}

/**
 * La salle que désigne une adresse, ou `null` pour l'écran de choix.
 *
 * Rend `null` aussi sur tout ce qui n'est pas une adresse de régie : appelée
 * sur `/admin`, elle ne doit pas inventer une salle nommée `admin`.
 */
export function regieRoomIdFromPath(pathname: string): string | null {
  if (pathname === REGIE_PATH || pathname === `${REGIE_PATH}/`) return null
  const prefix = `${REGIE_PATH}/`
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length)
  /*
   * Un seul segment, et pas un joker.
   *
   * `/regie/track-1/assets/x.js` est une requête d'asset, pas une salle nommée
   * `track-1/assets`. Le hub sert les assets sous ce préfixe, et les confondre
   * ferait rendre la coquille à la place d'un module.
   */
  if (rest === '' || rest.includes('/')) return null
  return decodeURIComponent(rest)
}
