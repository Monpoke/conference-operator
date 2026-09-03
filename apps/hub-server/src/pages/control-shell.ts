import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_EVENT_IDENTITY, type EventIdentity } from '@cloudnord/contract'
import { escapeHtml } from '@cloudnord/format'

/**
 * The mobile control app's shell.
 *
 * The same bundle a room machine serves, served this time by the hub — hence a
 * second shell renderer rather than sharing with
 * `room-client/src/core/regie-shell.ts`: the two applications cannot depend on
 * each other, and what they embed differs exactly where it matters.
 *
 * **No room state here.** The room machine inlines its whole `DisplayPayload`
 * because an F5 in the control room happens mid-talk and the window drives the
 * projector. A phone that drives nothing until someone has taken the room does
 * not have that argument: it connects, picks a room, and the view arrives on the
 * first poll. Embedding a state here would require resolving the operator before
 * rendering the page, to save a second for whoever has just signed in.
 *
 * The invariant holds as elsewhere: **no resource outside the origin**.
 */
export interface ControlShellOptions {
  event?: EventIdentity
  /** The room being driven, or `null` for the picker screen. */
  roomId?: string | null
  /**
   * The rooms, names included, set before any network call.
   *
   * These names are already public — the wall attendees scan shows them — and
   * setting them here lets the picker screen render before the connection is even
   * made. Without them, an operator signing in sees an empty list for the length
   * of a round trip, which reads as a hub with no program.
   */
  rooms?: { id: string; name: string }[]
  /**
   * Is Google configured?
   *
   * On a phone, typing an address and a password at the back of a room is exactly
   * the friction we are removing. The button only appears if the hub knows how to
   * serve it — offering a sign-in that fails costs more than a form.
   */
  google?: { domain: string } | null
  assets: ControlAssets
}

export interface ControlAssets {
  scripts: string[]
  styles: string[]
}

/**
 * The bundle's folder, searched for rather than counted.
 *
 * Same reason as `resolveConsoleBundle()`: this file is read at different depths
 * depending on whether we run from the sources or from an image, and a number of
 * `..` that is right for one is wrong for the other.
 */
export function resolveControlBundle(): { folder: string; manifest: string } | null {
  let folder = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(folder, 'apps', 'regie-web', 'dist')
    const manifest = join(candidate, '.vite', 'manifest.json')
    if (existsSync(manifest)) return { folder: candidate, manifest }
    const parent = dirname(folder)
    if (parent === folder) break
    folder = parent
  }
  return null
}

interface ManifestEntry {
  file: string
  css?: string[]
}

/** Production assets, read from the manifest: the names carry a fingerprint. */
export function productionControlAssets(manifest: string, base = '/regie/'): ControlAssets {
  const content = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, ManifestEntry>
  const entry = content['index.html']
  if (entry == null) {
    throw new Error(`Manifeste sans entrée « index.html » : ${manifest}`)
  }
  return {
    scripts: [base + entry.file],
    styles: (entry.css ?? []).map((path) => base + path),
  }
}

/** Development assets: the Vite server, behind the hub. */
export function developmentControlAssets(base = '/regie/'): ControlAssets {
  return { scripts: [`${base}@vite/client`, `${base}src/main.ts`], styles: [] }
}

/**
 * Scope boot payload, read by the bundle before it mounts.
 *
 * A second boot script rather than one more field in `#etat-initial`: the two
 * hosts do not serve the same content there, and merging them would force the
 * room machine to fabricate a scope it has never had to state. Its absence means
 * "local", which is also the case of `vite dev` serving `index.html` as is.
 */
export const SCOPE_ELEMENT_ID = 'regie-portee'

export function renderMobileControlShell(options: ControlShellOptions): string {
  const identity = options.event ?? DEFAULT_EVENT_IDENTITY
  const title = `Régie mobile — ${identity.shortName}`
  const boot = JSON.stringify({
    portee: 'distante',
    roomId: options.roomId ?? null,
    salles: options.rooms ?? [],
    google: options.google == null ? null : { domain: options.google.domain },
  }).replace(/</g, '\\u003c')

  const styles = options.assets.styles
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join('\n')
  const scripts = options.assets.scripts
    .map((src) => `<script type="module" src="${escapeHtml(src)}"></script>`)
    .join('\n')

  /*
   * `viewport-fit=cover` and `user-scalable=no`: this is a control desk, not a
   * document. A double-tap that zooms just as you aim at "Terminer" turns a
   * gesture into an accident, and scaling brings nothing to a page whose content
   * is already sized for a thumb.
   */
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(title)}</title>
${styles}
</head>
<body>
<div id="regie-root"></div>
<script id="${SCOPE_ELEMENT_ID}" type="application/json">${boot}</script>
${scripts}
</body>
</html>
`
}
