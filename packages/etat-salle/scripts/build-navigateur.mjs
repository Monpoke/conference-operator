/**
 * Fige l'automate dans un module TypeScript, pour les pages sans build.
 *
 * Même raison que la feuille Tailwind de `@cloudnord/ui` : les pages doivent
 * rester autonomes. Une balise `<script src>` casserait la régie à la première
 * coupure réseau, et un fichier lu sur disque au démarrage ne survivrait pas à
 * l'empaquetage Electron. Une constante inlinée dans le bundle ne peut pas
 * manquer à l'appel.
 *
 * Le format de sortie est une IIFE qui pose `EtatSalle` sur `globalThis` : les
 * pages sont un seul gros `<script>` sans modules, et `import` n'y a pas cours.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const racine = join(dirname(fileURLToPath(import.meta.url)), '..')
const module = join(racine, 'src', 'generated', 'navigateur.ts')

/**
 * Compile l'entrée navigateur et renvoie le JavaScript.
 *
 * Exporté pour que le test puisse rejouer exactement la même compilation et
 * comparer : une règle changée dans l'automate sans régénérer le module
 * laisserait les pages tourner sur l'ancienne — c'est-à-dire exactement la
 * divergence que ce paquet existe pour supprimer.
 */
export function compilerNavigateur() {
  const resultat = buildSync({
    entryPoints: [join(racine, 'src', 'navigateur.ts')],
    /**
     * Ancré à la racine du dépôt, sinon la sortie dépend d'où on appelle.
     *
     * esbuild écrit le chemin de chaque module en commentaire, relativement au
     * répertoire courant : compilé depuis la racine ou depuis le paquet, le
     * bundle différait sur cinq lignes de commentaire, et le test de fraîcheur
     * échouait sans que rien n'ait changé.
     */
    absWorkingDir: join(racine, '..', '..'),
    bundle: true,
    format: 'iife',
    globalName: 'EtatSalle',
    /**
     * Posé explicitement sur `globalThis`, et pas seulement déclaré en `var`.
     *
     * Un `var` de premier niveau devient une globale dans une page, mais reste
     * local quand le script est rejoué dans un `new Function` — ce que font les
     * tests de page, faute d'exécution des `<script>` par `innerHTML`. La
     * console rendait alors une liste de salles vide, en silence, et le test
     * qui aurait dû l'attraper ne voyait qu'un `querySelector` sans résultat.
     */
    footer: { js: 'globalThis.EtatSalle = EtatSalle;' },
    platform: 'browser',
    target: 'es2022',
    // Lisible : la page est un outil de diagnostic autant qu'un écran, et un
    // pavé minifié dans la console d'un poste de salle ne s'inspecte pas.
    minify: false,
    legalComments: 'none',
    write: false,
  })

  const sortie = resultat.outputFiles?.[0]
  if (sortie == null) throw new Error("esbuild n'a rien produit")
  return sortie.text.trim()
}

/** Échappe ce qui refermerait la balise `<script>` de la page qui l'inline. */
export const securiser = (js) => js.replace(/<\/script>/gi, '<\\/script>')

// Exécuté directement : régénère le module committé.
if (process.argv[1] === fileURLToPath(import.meta.url)) ecrireModule()

function ecrireModule() {
  const js = securiser(compilerNavigateur())

  mkdirSync(dirname(module), { recursive: true })
  writeFileSync(
    module,
    [
      '// Généré par `pnpm --filter @cloudnord/etat-salle build`. Ne pas modifier à la main.',
      '// Régénérer après toute modification de src/navigateur.ts ou de ce qu\'il exporte.',
      '',
      `export const MACHINE_JS = ${JSON.stringify(js)}`,
      '',
    ].join('\n'),
  )
  console.log(`automate compilé : ${(js.length / 1024).toFixed(1)} Ko → src/generated/navigateur.ts`)
}

/** Relit le module committé, pour les tests qui veulent le comparer. */
export function lireModule() {
  return readFileSync(module, 'utf8')
}
