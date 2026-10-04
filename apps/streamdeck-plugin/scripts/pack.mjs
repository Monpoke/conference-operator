import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The `.streamDeckPlugin` file, packed from a **copy** of the plugin folder.
 *
 * `streamdeck pack --version` writes the version into the manifest it packs —
 * on the committed one, every build left the repository dirty. Packing a copy
 * keeps the source untouched.
 *
 *   node scripts/pack.mjs [version]   — four numbers, `0.1.0.0` by default
 *
 * Linux is declared in `manifest.linux.json`, not in `manifest.json`: Elgato's
 * schema allows only `mac` and `windows` there, and `pack` refuses anything
 * else. There is no Elgato application for Linux; OpenDeck runs Stream Deck
 * plugins there, and merges `manifest.<os>.json` over the manifest. Without
 * it, OpenDeck only finds `windows` and treats the plugin as one for Wine —
 * a `.js` entry point still runs on the machine's own Node.js, but the plugin
 * would be claiming a platform it is not using.
 */
const NAME = 'io.github.monpoke.conference-operator.sdPlugin'
const root = resolve(import.meta.dirname, '..')
const version = process.argv[2] ?? '0.1.0.0'
const scratch = mkdtempSync(join(tmpdir(), 'streamdeck-pack-'))
const release = join(root, 'release')

try {
  // The logs a local run may have left are no part of a package.
  cpSync(join(root, NAME), join(scratch, NAME), {
    recursive: true,
    filter: (source) => !source.includes(`${NAME}/logs`),
  })
  mkdirSync(release, { recursive: true })
  execFileSync(
    join(root, 'node_modules', '.bin', 'streamdeck'),
    ['pack', join(scratch, NAME), '--output', release, '--force', '--version', version, '--no-update-check'],
    { stdio: 'inherit' },
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
