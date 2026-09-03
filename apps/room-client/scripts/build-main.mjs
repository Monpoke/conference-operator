import { build } from 'esbuild'
import { rm } from 'node:fs/promises'

/**
 * The main process's bundle, and the preload's.
 *
 * Necessary: `tsx` does not run inside a packaged Electron. We produce a single
 * CommonJS file, leaving out what cannot be bundled — `electron` (supplied by the
 * runtime) and the native modules, which must stay `.node` files loaded from
 * `node_modules`.
 *
 * Two outputs, and not one: a preload runs in the renderer, so it cannot be
 * included in the main process's bundle. It travels alongside, in the same folder
 * — which is what `hub-window.ts` assumes when resolving it from `__dirname`.
 */
await rm('dist', { recursive: true, force: true })

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  // `better-sqlite3` embeds a native binary; `qrcode` and `obs-websocket-js` are
  // bundlable but follow the same rule for rebuild simplicity.
  external: ['electron', 'better-sqlite3'],
  logLevel: 'info',
  metafile: true,
}

/**
 * Reserved for the main process, and above all not for the preload.
 *
 * Without this redefinition, esbuild replaces `import.meta` with `{}` in the CJS
 * output: every `new URL(x, import.meta.url)` then throws "Invalid URL" when the
 * bundle loads. As `define` only accepts an identifier, we go through a constant
 * injected in a banner.
 *
 * But a preload runs in a sandboxed renderer, where `require` only gives access to
 * a handful of modules — `node:url` is not one of them. The banner therefore
 * failed there at load time, the bridge was never set up, and the window stayed
 * mute with not a line of error on the main process side.
 */
const bundleUrl = {
  define: { 'import.meta.url': '__bundleUrl' },
  banner: {
    js: 'const __bundleUrl = require("node:url").pathToFileURL(__filename).href;',
  },
}

const outputs = await Promise.all([
  build({ ...common, ...bundleUrl, entryPoints: ['src/main/index.ts'], outfile: 'dist/main.cjs' }),
  build({ ...common, entryPoints: ['src/main/preload-hub.ts'], outfile: 'dist/preload-hub.cjs' }),
])

const bytes = outputs
  .flatMap((output) => Object.values(output.metafile.outputs))
  .reduce((total, o) => total + o.bytes, 0)
console.log(`bundle: ${(bytes / 1024).toFixed(0)} Ko`)
