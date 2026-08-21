import { build } from 'esbuild'
import { rm } from 'node:fs/promises'

/**
 * Bundle du processus principal.
 *
 * Nécessaire : `tsx` ne tourne pas dans un Electron empaqueté. On produit un
 * CommonJS unique, en laissant dehors ce qui ne peut pas être bundlé —
 * `electron` (fourni par le runtime) et les modules natifs, qui doivent rester
 * des `.node` chargés depuis `node_modules`.
 */
await rm('dist', { recursive: true, force: true })

const result = await build({
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  // `better-sqlite3` embarque un binaire natif ; `qrcode` et `obs-websocket-js`
  // sont bundlables mais suivent la même règle par simplicité de rebuild.
  external: ['electron', 'better-sqlite3'],
  /**
   * Sans cette redéfinition, esbuild remplace `import.meta` par `{}` en sortie
   * CJS : tout `new URL(x, import.meta.url)` lève alors « Invalid URL » au
   * chargement du bundle. `define` n'acceptant qu'un identifiant, on passe par
   * une constante injectée en préambule.
   */
  define: { 'import.meta.url': '__urlDuBundle' },
  banner: {
    js: 'const __urlDuBundle = require("node:url").pathToFileURL(__filename).href;',
  },
  logLevel: 'info',
  metafile: true,
})

const octets = Object.values(result.metafile.outputs).reduce((total, o) => total + o.bytes, 0)
console.log(`bundle: ${(octets / 1024).toFixed(0)} Ko`)
