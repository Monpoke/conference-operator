import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveControlBundleFrom } from '../src/core/control-shell.js'

/**
 * What the installer lays down, and what the machine goes looking for.
 *
 * Two files must agree without knowing each other: `electron-builder.yml`
 * decides **where** the control bundle lands on an installed machine, and
 * `resolveControlBundleFrom` walks up the folders to find it there. Their
 * disagreement would only show up in a room — the control app would answer 503
 * on a machine where everything else works, and nobody would trace that back to
 * a line of YAML.
 *
 * Checked on a reconstructed tree rather than on a real package: producing an
 * installer takes six minutes and downloads a hundred megabytes of Electron.
 * What is at stake here is an agreement between two paths, not the packaging
 * chain — that one is exercised by hand, before a delivery.
 */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

interface Config {
  extraResources: { from: string; to: string; filter?: string[] }[]
}

const config = load(readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')) as Config
const control = config.extraResources.find((entry) => entry.from.includes('regie-web'))

let dir: string

afterEach(() => {
  if (dir != null) rmSync(dir, { recursive: true, force: true })
})

describe('control bundle inside the package', () => {
  it('is indeed declared among the embedded resources', () => {
    expect(control).toBeDefined()
    expect(control!.from).toBe('../regie-web/dist')
  })

  it('lands where the folder walk-up looks for it', () => {
    /*
     * An installed machine's tree, reduced to what matters: the main process
     * bundle lives in `resources/app.asar/dist`, the embedded resources beside
     * it, under `resources/`.
     */
    dir = mkdtempSync(join(tmpdir(), 'cloudnord-package-'))
    const manifest = join(dir, 'resources', control!.to, '.vite', 'manifest.json')
    mkdirSync(dirname(manifest), { recursive: true })
    writeFileSync(manifest, '{}')

    const found = resolveControlBundleFrom(join(dir, 'resources', 'app.asar', 'dist'))

    expect(found?.manifest).toBe(manifest)
  })

  it('does not let the source map ship', () => {
    // Two megabytes nobody opens on a room machine. It stays on the build
    // machine, where a reported stack trace can be read back afterwards.
    expect(control!.filter).toContain('!**/*.map')
  })
})
