import { build } from 'esbuild'
import { rm } from 'node:fs/promises'

/**
 * Bundle du processus principal, et celui du préchargement.
 *
 * Nécessaire : `tsx` ne tourne pas dans un Electron empaqueté. On produit un
 * CommonJS unique, en laissant dehors ce qui ne peut pas être bundlé —
 * `electron` (fourni par le runtime) et les modules natifs, qui doivent rester
 * des `.node` chargés depuis `node_modules`.
 *
 * Deux sorties, et pas une : un préchargement s'exécute dans le renderer, il ne
 * peut donc pas être inclus dans le bundle du processus principal. Il voyage à
 * côté, dans le même dossier — c'est ce que `fenetre-hub.ts` suppose en le
 * résolvant depuis `__dirname`.
 */
await rm('dist', { recursive: true, force: true })

const commun = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  // `better-sqlite3` embarque un binaire natif ; `qrcode` et `obs-websocket-js`
  // sont bundlables mais suivent la même règle par simplicité de rebuild.
  external: ['electron', 'better-sqlite3'],
  logLevel: 'info',
  metafile: true,
}

/**
 * Réservé au processus principal, et surtout pas au préchargement.
 *
 * Sans cette redéfinition, esbuild remplace `import.meta` par `{}` en sortie
 * CJS : tout `new URL(x, import.meta.url)` lève alors « Invalid URL » au
 * chargement du bundle. `define` n'acceptant qu'un identifiant, on passe par
 * une constante injectée en préambule.
 *
 * Mais un préchargement s'exécute dans un renderer en bac à sable, où `require`
 * ne donne accès qu'à une poignée de modules — `node:url` n'en fait pas partie.
 * La bannière y échouait donc au chargement, le pont n'était jamais posé, et la
 * fenêtre restait muette sans une ligne d'erreur côté processus principal.
 */
const urlDuBundle = {
  define: { 'import.meta.url': '__urlDuBundle' },
  banner: {
    js: 'const __urlDuBundle = require("node:url").pathToFileURL(__filename).href;',
  },
}

const sorties = await Promise.all([
  build({ ...commun, ...urlDuBundle, entryPoints: ['src/main/index.ts'], outfile: 'dist/main.cjs' }),
  build({ ...commun, entryPoints: ['src/main/preload-hub.ts'], outfile: 'dist/preload-hub.cjs' }),
])

const octets = sorties
  .flatMap((sortie) => Object.values(sortie.metafile.outputs))
  .reduce((total, o) => total + o.bytes, 0)
console.log(`bundle: ${(octets / 1024).toFixed(0)} Ko`)
