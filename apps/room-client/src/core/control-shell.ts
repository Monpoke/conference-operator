import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DisplayPayload } from '@conference-operator/contract'
import { escapeHtml } from '@conference-operator/format'

/**
 * The control app's shell.
 *
 * The machine serves a bundle, but it always renders the page that loads it, and
 * for a stronger reason than at the console: **the complete state goes out in the
 * page**. A reload of the control app almost always happens at the worst moment —
 * the window has frozen, the operator hits F5 during the talk. Waiting for the
 * stream's first message before painting anything would give half a second of
 * blank screen at that very instant.
 *
 * The self-sufficiency invariant holds in the shape it took at the console: **no
 * resource outside the served origin**. It weighs more here — the room machine
 * sometimes runs with no network at all, and everything it displays comes from
 * its own `127.0.0.1`.
 */
export interface ControlShellOptions {
  /** The room's complete state, embedded to avoid the blank screen on F5. */
  initialPayload: DisplayPayload
  assets: ControlAssets
  /** The event's name, to title the window. */
  eventName?: string | null
}

export interface ControlAssets {
  scripts: string[]
  styles: string[]
}

/**
 * The bundle's directory, searched for rather than counted.
 *
 * The same reason as for the hub's console and the client's migrations: this file
 * is read at different depths depending on whether one runs from the sources,
 * from the esbuild bundle, or from an Electron package — and a number of `..`
 * right for one is wrong for the others.
 */
export function resolveControlBundle(): { directory: string; manifest: string } | null {
  return resolveControlBundleFrom(dirname(fileURLToPath(import.meta.url)))
}

/**
 * The walk up itself, separated so it can be exercised.
 *
 * The path it ends up finding on an installed machine is written elsewhere: in
 * `extraResources` of `electron-builder.yml`. Two files have to agree, and their
 * disagreement would only show at a room's editing time — the control app would
 * answer 503 on a machine where everything else works. A test ties the two.
 */
export function resolveControlBundleFrom(start: string): { directory: string; manifest: string } | null {
  let directory = start
  for (;;) {
    const candidate = join(directory, 'apps', 'control-web', 'dist')
    const manifest = join(candidate, '.vite', 'manifest.json')
    if (existsSync(manifest)) return { directory: candidate, manifest }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

interface ManifestEntry {
  file: string
  css?: string[]
}

/**
 * The production assets, read from the manifest.
 *
 * Reading the names rather than guessing them: they carry a fingerprint, which
 * makes it possible to serve them as `immutable` — on a room machine, the control
 * app is reopened several times a day.
 */
export function productionAssets(manifest: string, base = '/regie/'): ControlAssets {
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
 * The development assets: the Vite server, behind the room machine.
 *
 * The proxy's direction is imposed, as at the hub: it is the machine that carries
 * the state stream, the control actions and the VU meter, all on its origin.
 * Putting Vite in front would require proxying an SSE stream and an OBS WebSocket
 * for the sole comfort of hot reloading.
 */
export function developmentAssets(base = '/regie/'): ControlAssets {
  return { scripts: [`${base}@vite/client`, `${base}src/main.ts`], styles: [] }
}

export function renderControlShell(options: ControlShellOptions): string {
  const title = options.eventName == null ? 'Régie de salle' : `Régie — ${options.eventName}`
  const state = JSON.stringify(options.initialPayload).replace(/</g, '\\u003c')

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
<title>${escapeHtml(title)}</title>
${styles}
</head>
<body>
<div id="regie-root"></div>
<script id="etat-initial" type="application/json">${state}</script>
${scripts}
</body>
</html>
`
}
