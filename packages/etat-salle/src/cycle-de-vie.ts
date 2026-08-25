/**
 * Cycle de vie d'une conférence : le seul état de la journée qui soit une
 * décision.
 *
 * `scheduled` n'est jamais écrit — on n'enregistre que ce qui s'est produit,
 * et l'absence de ligne *est* l'état par défaut. La table ci-dessous dit donc
 * ce qu'on a le droit de faire depuis chaque état, pas ce qu'on stocke.
 *
 * Elle vit ici, et pas dans le hub qui écrit ni dans la régie qui commande,
 * parce que les deux la connaissaient déjà séparément : la régie grisait
 * « Terminer » sur une conférence non lancée pendant que la procédure du hub
 * l'acceptait sans broncher. Deux endroits pour une même règle, c'est un
 * endroit de trop — et c'est celui qu'on oublie qui décide le jour J.
 */

export const STATUTS = ['scheduled', 'running', 'ended'] as const
export type StatutConference = (typeof STATUTS)[number]

/** Les trois gestes possibles sur une conférence. */
export const ACTIONS = ['start', 'end', 'reset'] as const
export type ActionConference = (typeof ACTIONS)[number]

/**
 * Statut atteint par une action, ou `null` quand l'action n'a pas de sens
 * depuis cet état.
 *
 * Deux choix méritent d'être dits.
 *
 * `start` reste ouvert depuis `ended` : une clôture automatique qui tombe sur
 * un talk qui n'était pas fini doit pouvoir se rattraper d'un geste, sans
 * passer par « Remettre à venir ». Le refuser obligerait l'opérateur à deux
 * clics au pire moment de la journée.
 *
 * `reset` est autorisé depuis partout, y compris `running`. C'est
 * l'échappatoire : elle ne sert qu'à réparer une fausse manœuvre, et une
 * échappatoire conditionnelle n'en est pas une. L'IHM ne l'offre aujourd'hui
 * que sur une conférence terminée, mais c'est un choix de surface, pas une
 * règle du domaine.
 */
const TRANSITIONS: Record<
  StatutConference,
  Record<ActionConference, StatutConference | null>
> = {
  scheduled: { start: 'running', end: null, reset: 'scheduled' },
  running: { start: null, end: 'ended', reset: 'scheduled' },
  ended: { start: 'running', end: null, reset: 'scheduled' },
}

/**
 * Ce que devient une conférence, ou `null` si le geste est refusé.
 *
 * `statutApres('running', 'start')` vaut `null` : la conférence tourne déjà.
 */
export function statutApres(
  depuis: StatutConference,
  action: ActionConference,
): StatutConference | null {
  return TRANSITIONS[depuis][action]
}

export function transitionAutorisee(
  depuis: StatutConference,
  action: ActionConference,
): boolean {
  return TRANSITIONS[depuis][action] != null
}

/**
 * Pourquoi le geste est refusé, en une phrase destinée à l'opérateur.
 *
 * Rend `null` quand il ne l'est pas. Le message dit l'état constaté plutôt que
 * la règle enfreinte : en régie, « déjà lancée » se comprend tout de suite,
 * « transition interdite » demande d'aller lire un tableau.
 */
export function refusDeTransition(
  depuis: StatutConference,
  action: ActionConference,
): string | null {
  if (transitionAutorisee(depuis, action)) return null
  if (action === 'start') return 'Cette conférence est déjà lancée.'
  return depuis === 'ended'
    ? 'Cette conférence est déjà terminée.'
    : "Cette conférence n'a pas été lancée : il n'y a rien à terminer."
}

/**
 * Une décision prise *après* l'instant qu'on regarde ne s'applique pas.
 *
 * Elle appartient à une journée qui n'a pas encore eu lieu — ce qui n'arrive
 * qu'avec une horloge simulée, quand on la recule pour rejouer un moment. Le
 * talk lancé lors d'un essai à 11 h ne doit pas être « en cours » en revenant à
 * 08:38 : personne ne l'avait démarré à cette heure-là.
 *
 * On filtre **à la lecture** plutôt que d'effacer la décision : ré-avancer
 * l'horloge doit retrouver la journée exactement là où on l'avait laissée.
 * Sous une horloge réelle, la règle ne se voit jamais — aucune décision n'est
 * datée du futur.
 *
 * Une date illisible reste applicable : un état qu'on ne sait pas situer dans
 * le temps est un problème de données, pas une raison de le faire disparaître.
 */
export function decisionApplicable(deciseAMs: number | null | undefined, nowMs: number): boolean {
  if (deciseAMs == null || Number.isNaN(deciseAMs)) return true
  return deciseAMs <= nowMs
}
