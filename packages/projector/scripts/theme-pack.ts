/**
 * Zips a theme's folder into the package the console imports.
 *
 *   pnpm theme:pack themes/cloudnord [dist/themes]
 *
 * Checked exactly as the hub checks it on import: a package this script writes
 * is one the console accepts. The archive is reproducible — same files, same
 * bytes, same sha — so packing twice does not make the rooms fetch it again.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseThemePackage, pickThemeFiles, readThemeFolder, ThemePackageError, themeSha, zipTheme } from '../src/server/index.js'

// Run through pnpm, from the package: the paths given are the caller's.
const from = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path)
const [folder, out = 'dist/themes'] = process.argv.slice(2)
if (folder == null) {
  console.error('usage : pnpm theme:pack <dossier du thème> [dossier de sortie]')
  process.exit(2)
}

// The theme's own files: a repository's folder may carry the loop's content beside it.
const files = pickThemeFiles(readThemeFolder(from(folder)))
try {
  const { manifest } = parseThemePackage(files)
  const zip = zipTheme(files)
  mkdirSync(from(out), { recursive: true })
  const target = join(from(out), `${manifest.id}.zip`)
  writeFileSync(target, zip)
  console.log(`${manifest.nom} ${manifest.version} → ${target}`)
  console.log(`${files.size} fichiers, ${(zip.byteLength / 1024).toFixed(0)} ko, sha256 ${themeSha(zip)}`)
} catch (error) {
  if (!(error instanceof ThemePackageError)) throw error
  console.error(`Paquet refusé :\n${error.problems.map((problem) => `  - ${problem}`).join('\n')}`)
  process.exit(1)
}
