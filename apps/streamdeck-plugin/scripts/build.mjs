import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * The plugin's bundle, into the `.sdPlugin` folder Stream Deck loads.
 *
 * ESM, because the SDK is ESM only — hence the `bin/package.json` saying so,
 * next to the bundle. One file, dependencies included: Stream Deck runs the
 * plugin with `--no-global-search-paths`, from a folder with no `node_modules`.
 *
 * The SDK's `ws` is CommonJS and `require`s Node's own modules; bundled into ESM,
 * those calls need a `require` to exist — the banner provides it.
 */
const root = resolve(import.meta.dirname, '..')
const bin = join(root, 'io.github.monpoke.conference-operator.sdPlugin', 'bin')

await mkdir(bin, { recursive: true })
await build({
  entryPoints: [join(root, 'src', 'plugin.ts')],
  outfile: join(bin, 'plugin.js'),
  bundle: true,
  platform: 'node',
  // The manifest asks Stream Deck for Node 24.
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
})
await writeFile(join(bin, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`)
