import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_EVENT_IDENTITY, type EventIdentity, type ExecutionMode } from '@conference-operator/contract'
import { escapeHtml } from '@conference-operator/format'

/**
 * The console's shell.
 *
 * The hub serves a bundle, but it always renders the page that loads it — and
 * that is deliberate. Three things must be known to the console **before** its
 * first network call, exactly as in the template days: the event's name, which
 * is the first word read; the mode, on which the very existence of the
 * development view depends; and whether the Google button has a reason to be.
 *
 * What changes is what the shell contains: tags pointing at hashed files, served
 * by that same hub. The self-containment invariant is not abandoned, it is
 * restated — **no resource outside the origin**. A tag pointing at a CDN would
 * break the page at the first outage; an asset served by the process that
 * already serves the page cannot.
 */
export interface ConsoleShellOptions {
  mode?: ExecutionMode
  event?: EventIdentity
  google?: { domain: string } | null
  /** Assets to load. Resolved by `resolveConsoleBundle()`, or pointed at Vite in dev. */
  assets: ConsoleAssets
}

export interface ConsoleAssets {
  /** Modules to load, in order. */
  scripts: string[]
  /** Sheets to set before the first render, to avoid the flash. */
  styles: string[]
}

/**
 * The bundle's folder, searched for rather than counted.
 *
 * Same reason as for the room client's migrations (`store.ts`): this file is read
 * at different depths depending on whether we run from the sources or from an
 * image, and a number of `..` that is right for one is wrong for the other. The
 * defect is discovered at deployment, on a 404 that names nothing.
 */
export function resolveConsoleBundle(): { folder: string; manifest: string } | null {
  const visited: string[] = []
  let folder = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(folder, 'apps', 'hub-admin', 'dist')
    visited.push(candidate)
    const manifest = join(candidate, '.vite', 'manifest.json')
    if (existsSync(manifest)) return { folder: candidate, manifest }
    const parent = dirname(folder)
    if (parent === folder) break
    folder = parent
  }
  return null
}

/** What Vite's manifest says about the entry point. */
interface ManifestEntry {
  file: string
  css?: string[]
}

/**
 * Production assets, read from the manifest.
 *
 * Reading the manifest rather than guessing the names: they carry a fingerprint,
 * which is what lets them be served `immutable` and stops 45 kB of CSS being
 * re-downloaded on every navigation.
 */
export function productionAssets(manifest: string, base = '/admin/'): ConsoleAssets {
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

/**
 * Development assets: the Vite server, behind the hub.
 *
 * The direction of the proxy is imposed, and not by convenience. The hub carries
 * Better Auth's cookies, `/rpc`, the rooms' WebSocket, and above all `/sw.js` —
 * whose **scope depends on the path it is served from**. Putting Vite in front
 * would break the service worker's scope and the cookies' origin.
 */
export function developmentAssets(base = '/admin/'): ConsoleAssets {
  return { scripts: [`${base}@vite/client`, `${base}src/main.ts`], styles: [] }
}

export function renderConsoleShell(options: ConsoleShellOptions): string {
  const identity = options.event ?? DEFAULT_EVENT_IDENTITY
  const name = escapeHtml(identity.name)
  const boot = JSON.stringify({
    mode: options.mode ?? 'production',
    event: identity,
    google: options.google == null ? null : { domain: options.google.domain },
  }).replace(/</g, '\\u003c')

  const styles = options.assets.styles
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join('\n')
  const scripts = options.assets.scripts
    .map((src) => `<script type="module" src="${escapeHtml(src)}"></script>`)
    .join('\n')

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${name} — console hub</title>
${styles}
</head>
<body class="bg-canvas font-sans text-text">
<div id="console-root"></div>
<script id="console-boot" type="application/json">${boot}</script>
${scripts}
</body>
</html>
`
}
