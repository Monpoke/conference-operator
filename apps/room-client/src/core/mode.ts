import type { ModeExecution } from '@cloudnord/contract'

/**
 * Mode d'exécution de la salle.
 *
 * Un seul interrupteur devant les commodités de développement, au lieu d'une
 * variable par commodité. Deux raisons, et la seconde compte plus que la
 * première.
 *
 * 1. Le jour J, ce qu'on doit vérifier tient en une ligne.
 * 2. Les réglages de développement ne s'appliquent **que** dans ce mode. Un
 *    `OBS_MOCK=1` oublié dans un raccourci, c'est une journée entière filmée
 *    par une instance OBS qui n'existe pas — la panne se découvre au montage,
 *    quand il n'y a plus rien à rattraper.
 *
 * Le défaut est `production` : le défaut doit être le cas dangereux, pas le
 * cas confortable.
 */
export interface ModeSalle {
  mode: ModeExecution
  /** OBS simulé plutôt que deux vraies instances. */
  obsSimule: boolean
  /** Heure locale simulée, pour développer sans hub. */
  heureSimulee: string | null
  /**
   * Réglages présents dans l'environnement et laissés sans effet, avec pourquoi.
   *
   * Neutralisés bruyamment, et avec leur raison : « ignoré » tout court
   * enverrait chercher au mauvais endroit, et les deux causes — réservé au
   * développement, ou disparu — ne se corrigent pas de la même façon.
   */
  ignores: IgnoreSalle[]
}

export interface IgnoreSalle {
  variable: string
  raison: string
}

export function lireMode(env: NodeJS.ProcessEnv = process.env): ModeSalle {
  const dev = env.MODE === 'dev'
  const ignores: IgnoreSalle[] = []

  // Obsolète dans les deux modes : en développement, OBS est simulé par défaut.
  // Le trouver dans un raccourci veut dire que quelqu'un compte dessus.
  if (vraie(env.OBS_MOCK)) {
    ignores.push({
      variable: 'OBS_MOCK',
      raison: 'remplacé par MODE=dev, qui simule OBS par défaut (OBS_REEL=1 pour de vraies instances)',
    })
  }
  if (!dev && (env.HEURE_SIMULEE ?? '') !== '') {
    ignores.push({ variable: 'HEURE_SIMULEE', raison: 'réservé au mode développement (MODE=dev)' })
  }

  return {
    mode: dev ? 'dev' : 'production',
    // Simulé par défaut en développement : c'est le cas courant, et exiger une
    // variable de plus pour le cas courant se paie en oublis. `OBS_REEL` n'est
    // jamais signalé en production : sans effet, mais ce qu'il demande est
    // justement ce qui se passe, et avertir sèmerait le doute.
    obsSimule: dev && env.OBS_REEL !== '1',
    heureSimulee: dev ? (env.HEURE_SIMULEE ?? null) : null,
    ignores,
  }
}

/** Les formes qu'on écrit dans un `.env` pour dire « oui ». */
function vraie(valeur: string | undefined): boolean {
  return valeur === '1' || valeur === 'true'
}

/**
 * Heure simulée de la salle, exprimée en **décalage** sur l'horloge machine.
 *
 * Un décalage, et surtout pas une horloge de remplacement. Tout le reste du
 * client compte à partir de `Date.now()` — les pages servies, qui n'ont accès
 * qu'à l'horloge du navigateur, et la file de remontée, qui date ses
 * événements. Remplacer l'horloge du seul cœur applicatif les faisait diverger
 * en silence : le hub disait 16 h, les pages affichaient 16 h, et la régie
 * cherchait ses conférences plusieurs semaines plus loin.
 *
 * En décalage, l'heure avance toujours au rythme réel — un compte à rebours
 * figé ne se distingue pas d'un écran planté — et l'heure du hub reprend
 * simplement la main à la première synchronisation, en remplaçant la valeur.
 */
export function decalageDuMode(mode: ModeSalle, base: () => number = Date.now): number {
  if (mode.heureSimulee == null) return 0
  const cible = Date.parse(mode.heureSimulee)
  if (Number.isNaN(cible)) throw new Error(`HEURE_SIMULEE illisible : ${mode.heureSimulee}`)
  return cible - base()
}
