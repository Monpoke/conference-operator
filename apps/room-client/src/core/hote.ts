import { readFileSync } from 'node:fs'
import { cpus, freemem, platform, totalmem } from 'node:os'
import type { HostLoad } from '@cloudnord/contract'

/**
 * Charge du poste qui fait tourner la salle.
 *
 * L'hôte, ici, c'est la machine sous OBS : celle qui encode, écrit les rushes
 * et sert l'écran. Quand elle sature, rien ne le dit — OBS perd des images en
 * silence et le rush est mauvais sans que personne le remarque avant le
 * editing. C'est la seule raison d'être de ce module : rendre visible, en
 * régie, ce que la salle ne peut pas entendre.
 */
export type { HostLoad }

export interface MoniteurHoteDeps {
  lireCpus?: () => { times: { user: number; nice: number; sys: number; idle: number; irq: number } }[]
  now?: () => number
  lireMemoire?: () => HostLoad['memory']
}

/**
 * `MemAvailable` plutôt que `freemem()` sous Linux.
 *
 * `freemem()` y compte le cache disque comme occupé : un poste parfaitement
 * sain s'y affiche à plus de 90 % de mémoire prise, et la pastille resterait
 * rouge en permanence — le plus sûr moyen de la faire ignorer le jour où elle
 * dit vrai. Windows, la machine de salle, n'a pas ce travers ; les postes de
 * développement, si.
 */
function memoireDisponible(): number | null {
  if (platform() !== 'linux') return null
  try {
    const trouve = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB$/m)
    return trouve == null ? null : Number(trouve[1]) * 1024
  } catch {
    return null
  }
}

/** Mémoire du système, occupée et totale. */
function memoireSysteme(): HostLoad['memory'] {
  const total = totalmem()
  if (!(total > 0)) return null
  const libre = memoireDisponible() ?? freemem()
  return { usedBytes: Math.max(0, total - libre), totalBytes: total }
}

/**
 * En deçà, on rend le relevé précédent plutôt qu'une nouvelle mesure.
 *
 * Les compteurs du noyau sont cumulatifs : deux lectures rapprochées ne
 * couvrent presque rien et donnent un chiffre qui saute de 0 à 100 sans que la
 * charge ait bougé. Deux fenêtres de régie ouvertes suffiraient à produire ça.
 */
const FENETRE_MIN_MS = 1000

interface Cumul {
  total: number
  inactif: number
  cores: number
}

function cumul(liste: ReturnType<NonNullable<MoniteurHoteDeps['lireCpus']>>): Cumul {
  let total = 0
  let inactif = 0
  for (const coeur of liste) {
    const t = coeur.times
    total += t.user + t.nice + t.sys + t.idle + t.irq
    inactif += t.idle
  }
  return { total, inactif, cores: liste.length }
}

/**
 * Rend une fonction de relevé, à appeler quand on veut savoir.
 *
 * Volontairement sans minuterie interne : rien ne tourne tant que personne ne
 * regarde, et la fenêtre mesurée est exactement l'intervalle entre deux
 * consultations de la régie. Une salle dont la régie est fermée ne paie rien.
 */
export function moniteurHote(deps: MoniteurHoteDeps = {}): () => HostLoad {
  const lire = deps.lireCpus ?? ((): ReturnType<NonNullable<MoniteurHoteDeps['lireCpus']>> => cpus())
  const lireMemoire = deps.lireMemoire ?? memoireSysteme
  const maintenant = deps.now ?? Date.now

  let repere = cumul(lire())
  let repereAt = maintenant()
  let dernierCpu: { cpu: number | null; cores: number; windowMs: number } = {
    cpu: null,
    cores: repere.cores,
    windowMs: 0,
  }

  return () => {
    const at = maintenant()
    // La mémoire est un instantané, pas une différence : elle se relit à chaque
    // appel, même quand la fenêtre du processeur est trop courte pour compter.
    const memory = lireMemoire()
    if (at - repereAt < FENETRE_MIN_MS) return { ...dernierCpu, memory }

    const courant = cumul(lire())
    const total = courant.total - repere.total
    const inactif = courant.inactif - repere.inactif
    const windowMs = at - repereAt
    repere = courant
    repereAt = at

    // Compteurs immobiles ou repartis de zéro (veille, machine virtuelle
    // migrée) : on garde le dernier chiffre honnête plutôt que d'en inventer un.
    if (total <= 0) return { ...dernierCpu, memory }

    dernierCpu = {
      cpu: Math.min(1, Math.max(0, (total - inactif) / total)),
      cores: courant.cores,
      windowMs,
    }
    return { ...dernierCpu, memory }
  }
}
