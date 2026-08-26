import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Adresse du hub, résolue au démarrage.
 *
 * Une variable d'environnement ne suffit pas : sur un poste de salle,
 * l'application se lance depuis un raccourci du bureau posé par l'installeur,
 * et personne n'ira éditer un raccourci Windows la veille de l'événement. Le
 * poste doit donc pouvoir *demander* l'adresse, et surtout s'en souvenir — la
 * question ne se pose qu'une fois par machine.
 *
 * Deux sources la dictent, et la première qui répond gagne :
 *
 * 1. `--hub=<url>` sur la ligne de commande — ce qu'on met dans un raccourci
 *    ou un script de déploiement quand on provisionne plusieurs postes ;
 * 2. `HUB_ORIGIN` dans l'environnement — la forme historique, gardée pour le
 *    développement et pour `pnpm dev`.
 *
 * Sans l'une des deux, **on demande à chaque lancement**, l'adresse mémorisée
 * pré-remplie dans le champ : valider, c'est repartir sur le même hub, et une
 * salle qu'on rebranche sur un autre hub — répétition, secours, poste déplacé —
 * n'a besoin de personne pour aller éditer un raccourci Windows. Un lancement
 * de plus coûte une touche Entrée ; se tromper de hub coûte une demi-journée
 * de captation envoyée au mauvais événement.
 *
 * Les deux sources dictées sont *aussi* mémorisées : ce qu'elles imposent
 * devient la proposition du lancement suivant.
 */
export const ADRESSE_HUB_PAR_DEFAUT = 'http://localhost:8787'

export interface AdresseImposee {
  valeur: string
  source: 'argument' | 'environnement'
}

/**
 * Adresse dictée du dehors, sans rien lire du disque.
 *
 * Lue par préfixe plutôt que par position : `electron dist/main.cjs --hub=…`
 * en développement et `Régie de salle.exe --hub=…` sur le poste n'ont pas le
 * même `argv[1]`, et compter les arguments se serait cassé sur l'un des deux.
 */
export function adresseImposee(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): AdresseImposee | null {
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i]!
    if (argument.startsWith('--hub=')) return { valeur: argument.slice('--hub='.length), source: 'argument' }
    // Forme séparée, pour un raccourci écrit à la main : `--hub http://…`.
    if (argument === '--hub' && i + 1 < argv.length) return { valeur: argv[i + 1]!, source: 'argument' }
  }
  const env_ = env.HUB_ORIGIN?.trim()
  return env_ != null && env_ !== '' ? { valeur: env_, source: 'environnement' } : null
}

/**
 * Ramène une saisie à une origine utilisable, ou explique pourquoi elle ne
 * l'est pas.
 *
 * Le schéma est optionnel à la saisie : sur un poste de salle on tape une IP
 * et un port, pas une URL. Le chemin, lui, est retiré — tout le client résout
 * des chemins absolus (`/health`, `/rpc`, `/ws`) sur cette origine, donc un
 * `/admin` collé depuis la barre d'adresse du navigateur n'aurait servi à
 * rien ; le champ réaffiche la valeur normalisée, la coupe se voit.
 */
export function normaliserAdresseHub(saisie: string): string {
  const brute = saisie.trim()
  if (brute === '') throw new Error('Adresse vide — indiquer par exemple http://192.168.1.10:8787')

  const avecSchema = /^[a-z][a-z0-9+.-]*:\/\//i.test(brute) ? brute : `http://${brute}`
  let url: URL
  try {
    url = new URL(avecSchema)
  } catch {
    throw new Error(`Adresse illisible : ${brute}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Adresse en ${url.protocol.replace(':', '')} : le hub se joint en http ou https`)
  }
  if (url.hostname === '') throw new Error(`Adresse sans machine : ${brute}`)
  return url.origin
}

/** Adresse mémorisée par le lancement précédent, ou `null`. */
export function lireAdresseHub(chemin: string): string | null {
  if (!existsSync(chemin)) return null
  const brute = readFileSync(chemin, 'utf8').trim()
  return brute === '' ? null : brute
}

export function ecrireAdresseHub(chemin: string, origine: string): void {
  mkdirSync(dirname(chemin), { recursive: true })
  writeFileSync(chemin, origine, 'utf8')
}

export interface ResolutionAdresseHub {
  /** Fichier d'adresse, hors base SQLite : il doit survivre à une remise à zéro du cache. */
  chemin: string
  argv?: readonly string[]
  env?: NodeJS.ProcessEnv
  /** Ouvre l'écran de saisie. `null` si l'opérateur ferme sans valider. */
  demander: (valeurInitiale: string) => Promise<string | null>
  onLog?: (niveau: 'warn' | 'error', message: string) => void
}

/**
 * Adresse retenue pour ce lancement, mémorisée au passage.
 *
 * Rend `null` quand l'opérateur ferme l'écran sans valider : il n'y a alors
 * rien à démarrer, et l'appelant quitte.
 */
export async function resoudreAdresseHub(options: ResolutionAdresseHub): Promise<string | null> {
  const { chemin, argv = process.argv, env = process.env, demander, onLog } = options

  const memorisee = valeurSaine(lireAdresseHub(chemin), (message) =>
    onLog?.('error', `Adresse du hub mémorisée illisible, elle sera redemandée : ${message}`),
  )

  const impose = adresseImposee(argv, env)
  if (impose != null) {
    const origine = valeurSaine(impose.valeur, (message) =>
      onLog?.('error', `Adresse du hub passée en ${impose.source} et refusée : ${message}`),
    )
    // Retenue sans rien demander : une adresse dictée l'est par un raccourci
    // ou un script, où il n'y a personne pour répondre à une fenêtre.
    if (origine != null) {
      if (origine !== memorisee) ecrireAdresseHub(chemin, origine)
      return origine
    }
    // Refusée : on ne démarre pas en silence sur l'adresse d'hier, on demande.
    return await saisir(impose.valeur)
  }

  return await saisir(memorisee ?? ADRESSE_HUB_PAR_DEFAUT)

  async function saisir(valeurInitiale: string): Promise<string | null> {
    const saisie = await demander(valeurInitiale)
    if (saisie == null) return null
    // La fenêtre normalise déjà pour pouvoir refuser en face de l'opérateur ;
    // repasser ici ne coûte rien et vaut mieux qu'une confiance implicite.
    const origine = normaliserAdresseHub(saisie)
    ecrireAdresseHub(chemin, origine)
    return origine
  }
}

function valeurSaine(valeur: string | null, onErreur: (message: string) => void): string | null {
  if (valeur == null) return null
  try {
    return normaliserAdresseHub(valeur)
  } catch (erreur) {
    onErreur(erreur instanceof Error ? erreur.message : String(erreur))
    return null
  }
}
