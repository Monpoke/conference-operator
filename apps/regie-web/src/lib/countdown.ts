import type { DisplayPayload } from '@cloudnord/contract'
import { prochaineConference } from '@cloudnord/etat-salle'

/**
 * Ce que compte le grand chronomètre.
 *
 * Avant le créneau, le temps qui reste **avant** de commencer ; à partir de son
 * heure, ce qu'il reste du créneau. Compter d'emblée vers la fin donnait
 * « 2:01:59 » en gros caractères à 8h38 sur la conférence de 9h50 : un chiffre
 * qui se lit comme un talk en cours, et qui a été lu ainsi.
 *
 * Un talk lancé en avance compte vers sa fin sans attendre son heure : dès
 * qu'on a appuyé sur « Commencer », c'est l'écart au programme qui décide de la
 * suite de la journée.
 *
 * Hors composant, parce que c'est une règle et non un rendu : elle se vérifie
 * sur des instants choisis, sans monter quoi que ce soit.
 */
export interface Countdown {
  ms: number
  /** Le décompte vise un début, pas une fin. Le badge le dit à côté du nombre. */
  beforeStart: boolean
}

export function countdownFor(payload: DisplayPayload, atMs: number): Countdown | null {
  const session = payload.state.targetSession
  if (session == null) return null
  const status = payload.state.sessionStates?.[session.id] ?? 'scheduled'

  /*
   * Une conférence terminée ne décompte plus rien.
   *
   * Le chronomètre continuait sur son créneau : « Terminer » appuyé à 10:35, il
   * restait quinze minutes à l'écran sur un talk que la salle venait de
   * quitter. Ce qu'on vient y chercher à ce moment-là est la seule chose qui
   * décide de la suite — dans combien de temps la prochaine commence.
   */
  if (status === 'ended') {
    const next = nextConference(payload, atMs)
    return next == null ? null : { ms: next.startsAtMs - atMs, beforeStart: true }
  }

  if (status === 'scheduled' && session.startsAtMs > atMs) {
    return { ms: session.startsAtMs - atMs, beforeStart: true }
  }
  return session.endsAtMs == null ? null : { ms: session.endsAtMs - atMs, beforeStart: false }
}

/**
 * La prochaine conférence de la salle : celle qui va encore se tenir.
 *
 * Pauses sautées — un déjeuner n'est pas ce qu'on attend — et conférences déjà
 * terminées sautées aussi. La règle est celle de l'automate, la même que le
 * banc d'essai déroule ; la page ne tranche pas elle-même.
 */
export function nextConference(
  payload: DisplayPayload,
  atMs: number,
): DisplayPayload['sessions'][number] | null {
  return prochaineConference(payload.sessions ?? [], atMs, payload.state.sessionStates ?? {})
}

/**
 * Temps qu'il devrait rester d'après le programme.
 *
 * Pas le temps écoulé depuis le début réel : c'est l'écart au créneau prévu qui
 * compte, parce que c'est lui qui décale la suite de la journée.
 */
export function scheduleGapMs(payload: DisplayPayload, atMs: number): number | null {
  const session = payload.state.targetSession
  if (session?.endsAtMs == null) return null
  return session.endsAtMs - atMs
}
