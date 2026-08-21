/**
 * Horloge du hub.
 *
 * Une seule source de temps pour tout ce qui est daté côté serveur : heure de
 * synchronisation, émission des commandes, décisions sur les conférences,
 * clôture automatique. Les salles s'alignent dessus via l'offset qu'elles
 * mesurent à chaque `sync` — simuler ici suffit donc à déplacer tout le système.
 *
 * C'est ce qui manquait : une horloge simulée uniquement côté salle diverge de
 * celle du hub, et tout ce qui compare les deux — l'obsolescence d'une commande,
 * par exemple — se met à mentir.
 */
export interface Clock {
  now(): number
  nowIso(): string
  /** Vrai quand l'heure est simulée : à signaler, sinon personne ne comprendra. */
  readonly simulated: boolean
}

export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    simulated: false,
  }
}

/**
 * Horloge décalée vers un instant donné, qui avance ensuite au rythme réel.
 *
 * Avancer plutôt que figer est délibéré : un compte à rebours figé ne se
 * distingue pas d'un écran planté, et la clôture automatique ne se
 * déclencherait jamais.
 */
export function simulatedClock(target: string, base: () => number = Date.now): Clock {
  const cible = Date.parse(target)
  if (Number.isNaN(cible)) {
    throw new Error(`Heure simulée illisible : ${target}`)
  }
  const depart = base()
  const now = (): number => cible + (base() - depart)

  return {
    now,
    nowIso: () => new Date(now()).toISOString(),
    simulated: true,
  }
}

/**
 * Horloge réglable à chaud.
 *
 * Permet de déplacer tout le système depuis la console, sans redémarrer le hub.
 * Chaque changement doit être suivi d'une diffusion aux salles : elles calent
 * leur offset sur `serverTime` et resteraient sinon sur l'ancienne heure
 * jusqu'à leur prochaine synchronisation.
 */
export interface MutableClock extends Clock {
  /** `null` revient à l'heure réelle. */
  setSimulated(target: string | null): void
}

export function mutableClock(initial: string | null = null): MutableClock {
  let interne: Clock = initial == null ? systemClock() : simulatedClock(initial)

  return {
    now: () => interne.now(),
    nowIso: () => interne.nowIso(),
    get simulated() {
      return interne.simulated
    },
    setSimulated(target) {
      // Validation avant remplacement : une heure illisible ne doit pas laisser
      // le hub sans horloge.
      interne = target == null ? systemClock() : simulatedClock(target)
    },
  }
}
