/**
 * Compile la feuille Tailwind et la fige dans un module TypeScript.
 *
 * Pourquoi passer par un module plutôt que servir un fichier `.css` : les pages
 * doivent rester autonomes — une balise `<link>` casserait l'écran à la
 * première coupure réseau, et un fichier lu sur disque au démarrage ne
 * survivrait pas à l'empaquetage Electron (le défaut a déjà coûté un
 * diagnostic sur le dossier de migrations). Une constante inlinée dans le
 * bundle ne peut pas manquer à l'appel.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const racine = join(dirname(fileURLToPath(import.meta.url)), '..')
const module = join(racine, 'src', 'generated', 'styles.ts')

/**
 * Compile la feuille et renvoie le CSS.
 *
 * Exporté pour que le test puisse rejouer exactement la même compilation et
 * comparer : une classe ajoutée dans une page sans régénérer la feuille
 * n'aurait aucun style et ne lèverait rien.
 */
export function compilerCss(sortie = join(racine, 'src', 'generated', 'styles.css')) {
  mkdirSync(dirname(sortie), { recursive: true })
  execFileSync(
    join(racine, 'node_modules', '.bin', 'tailwindcss'),
    ['--input', join(racine, 'src', 'theme.css'), '--output', sortie, '--minify'],
    { stdio: 'inherit', cwd: racine },
  )
  return readFileSync(sortie, 'utf8').trim()
}

/** Échappe ce qui refermerait la balise `<style>` de la page qui l'inline. */
export const securiser = (css) => css.replace(/<\/style>/gi, '<\\/style>')

// Exécuté directement : régénère le module committé.
if (process.argv[1] === fileURLToPath(import.meta.url)) ecrireModule()

function ecrireModule() {
  const css = compilerCss()

  writeFileSync(
    module,
    [
      '// Généré par `pnpm --filter @cloudnord/ui build`. Ne pas modifier à la main.',
      '// Régénérer après avoir ajouté des classes Tailwind dans une page.',
      '',
      `export const TAILWIND_CSS = ${JSON.stringify(securiser(css))}`,
      '',
    ].join('\n'),
  )
  console.log(`feuille compilée : ${(css.length / 1024).toFixed(1)} Ko → src/generated/styles.ts`)
}
