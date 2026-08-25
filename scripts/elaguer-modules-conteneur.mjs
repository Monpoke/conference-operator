/**
 * Élagage du magasin pnpm pour l'image du hub.
 *
 * Pourquoi : `pnpm install --prod` laisse quand même entrer une centaine de
 * mégaoctets d'outillage de test et de build. Ce n'est pas un bug de pnpm.
 * `better-auth` déclare `vitest` et `drizzle-kit` en **peer dependencies non
 * optionnelles** ; pnpm doit donc les matérialiser, et avec eux rolldown,
 * lightningcss, happy-dom et deux copies d'esbuild. Rien de tout cela n'est
 * atteignable depuis le hub qui tourne : ces paquets servent aux utilitaires de
 * test de better-auth et à sa CLI de génération de schéma, que le hub n'appelle
 * jamais — il applique des migrations SQL déjà écrites.
 *
 * Comment : plutôt qu'une liste de noms à la main, qui se périmerait en silence
 * à la première montée de version, on **recalcule ce qui est atteignable**. On
 * part du hub, on suit `dependencies` et `optionalDependencies` — jamais
 * `peerDependencies`, qui est précisément la porte par laquelle l'outillage
 * entre — et on supprime du magasin tout ce que ce parcours n'a pas visité.
 *
 * Ce que ça garantit et ce que ça ne garantit pas : un `import` statique d'un
 * paquet supprimé fait échouer le hub **au démarrage**, donc au déploiement,
 * pas en salle. Un `import()` dynamique d'une peer dependency échapperait en
 * revanche au calcul ; c'est pourquoi l'image est démarrée et exercée en fin de
 * build plutôt que simplement construite.
 *
 * S'exécute depuis la racine du dépôt, après l'installation.
 */
import { readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

const racine = process.cwd()
const magasin = join(racine, 'node_modules', '.pnpm')
const simulation = process.argv.includes('--simulation')

/** Résout `nom` depuis `depuis` en remontant les `node_modules`, comme Node. */
function resoudre(nom, depuis) {
  let dossier = depuis
  for (;;) {
    const candidat = join(dossier, 'node_modules', nom)
    try {
      return realpathSync(candidat)
    } catch {
      /* pas ici : on remonte */
    }
    const parent = dirname(dossier)
    if (parent === dossier) return null
    dossier = parent
  }
}

/** Le dossier `<nom>@<version>` du magasin dont relève ce chemin, s'il y en a un. */
function entreeDuMagasin(chemin) {
  const marqueur = `${sep}.pnpm${sep}`
  const position = chemin.indexOf(marqueur)
  if (position === -1) return null
  return chemin.slice(position + marqueur.length).split(sep)[0]
}

const visites = new Set()
const gardes = new Set()
const file = [realpathSync(join(racine, 'apps', 'hub-server'))]

while (file.length > 0) {
  const dossier = file.pop()
  if (visites.has(dossier)) continue
  visites.add(dossier)

  const entree = entreeDuMagasin(dossier)
  if (entree != null) gardes.add(entree)

  let manifeste
  try {
    manifeste = JSON.parse(readFileSync(join(dossier, 'package.json'), 'utf8'))
  } catch {
    continue
  }

  // `peerDependencies` volontairement absent : voir l'en-tête.
  const dependances = {
    ...(manifeste.dependencies ?? {}),
    ...(manifeste.optionalDependencies ?? {}),
  }
  for (const nom of Object.keys(dependances)) {
    const cible = resoudre(nom, dossier)
    // Une dépendance optionnelle non installée n'a rien d'anormal.
    if (cible != null) file.push(cible)
  }
}

const toutes = readdirSync(magasin, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== 'node_modules')
  .map((e) => e.name)

const aSupprimer = toutes.filter((nom) => !gardes.has(nom))

/** Taille approchée d'un dossier, en Mo — pour dire ce qu'on gagne. */
function megaoctets(chemin) {
  let total = 0
  const pile = [chemin]
  while (pile.length > 0) {
    const courant = pile.pop()
    let entrees
    try {
      entrees = readdirSync(courant, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entree of entrees) {
      const enfant = join(courant, entree.name)
      if (entree.isDirectory()) pile.push(enfant)
      else if (entree.isFile()) {
        try {
          total += statSync(enfant).size
        } catch {
          /* lien mort */
        }
      }
    }
  }
  return total / 1024 / 1024
}

let gagnes = 0
for (const nom of aSupprimer) {
  const chemin = join(magasin, nom)
  gagnes += megaoctets(chemin)
  if (!simulation) rmSync(chemin, { recursive: true, force: true })
}

const verbe = simulation ? 'à supprimer' : 'supprimés'
console.log(
  `élagage : ${gardes.size} paquets atteignables, ${aSupprimer.length} ${verbe} ` +
    `(${gagnes.toFixed(0)} Mo)`,
)
