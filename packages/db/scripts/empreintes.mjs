/**
 * Scelle les migrations publiées.
 *
 * Drizzle identifie une migration appliquée par le hash de son contenu. Régénérer
 * un fichier déjà publié change ce hash : sur une base existante, Drizzle ne
 * reconnaît plus rien, rejoue les CREATE TABLE et échoue. La seule issue devient
 * alors de supprimer la base — donc les comptes opérateurs et les appairages.
 *
 * Ce module fige les empreintes des fichiers publiés pour que la régression soit
 * détectée à la génération, pas au démarrage d'un hub qui contenait des données.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const racine = join(dirname(fileURLToPath(import.meta.url)), '..')
export const JEUX = ['hub', 'client']
const fichierEmpreintes = (jeu) => join(racine, 'migrations', jeu, 'empreintes.json')

const empreinte = (contenu) => createHash('sha256').update(contenu).digest('hex')

/** Migrations présentes sur le disque, par tag, dans l'ordre. */
export function migrations(jeu) {
  const dossier = join(racine, 'migrations', jeu)
  if (!existsSync(dossier)) return {}
  return Object.fromEntries(
    readdirSync(dossier)
      .filter((nom) => nom.endsWith('.sql'))
      .sort()
      .map((nom) => [nom.replace(/\.sql$/, ''), empreinte(readFileSync(join(dossier, nom)))]),
  )
}

export function scelles(jeu) {
  const chemin = fichierEmpreintes(jeu)
  return existsSync(chemin) ? JSON.parse(readFileSync(chemin, 'utf8')) : {}
}

/**
 * Compare le disque au sceau. Une migration nouvelle est normale ; une migration
 * publiée dont le contenu a changé, ou qui a disparu, ne l'est pas.
 */
export function verifier(jeu) {
  const surDisque = migrations(jeu)
  const attendues = scelles(jeu)
  const anomalies = []

  for (const [tag, hash] of Object.entries(attendues)) {
    if (!(tag in surDisque)) anomalies.push({ tag, probleme: 'supprimée' })
    else if (surDisque[tag] !== hash) anomalies.push({ tag, probleme: 'modifiée' })
  }
  const nouvelles = Object.keys(surDisque).filter((tag) => !(tag in attendues))
  return { anomalies, nouvelles }
}

export function sceller(jeu) {
  const surDisque = migrations(jeu)
  writeFileSync(fichierEmpreintes(jeu), `${JSON.stringify(surDisque, null, 2)}\n`)
  return surDisque
}
