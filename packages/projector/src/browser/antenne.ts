/**
 * Beyond this absence from the program scene, the loop starts again from the
 * welcome rather than where it stopped.
 *
 * A few seconds off air — a cut to the speaker, a glance at the room — and the
 * audience picks the loop up where it left it, mid-agenda. Two minutes and more,
 * and "where it stopped" means nothing to anyone in the room: the loop comes back
 * the way it does when the control room puts it up, from the welcome, with its
 * stinger.
 */
export const RETOUR_AU_DEBUT_MS = 120_000

/** What the loop does when its OBS source comes back into the program scene. */
export function auRetour(absentMs: number, tourne: boolean): 'reprendre' | 'recommencer' {
  // A held screen has no "where it stopped": it is the same screen.
  if (!tourne) return 'reprendre'
  return absentMs >= RETOUR_AU_DEBUT_MS ? 'recommencer' : 'reprendre'
}

/**
 * Past its own length plus this, a transition is stuck, and the clock ends it.
 *
 * A transition waits for animation frames, and an OBS Browser Source only gets
 * frames while OBS renders it: the loop was found on air frozen mid-stinger,
 * alive under a band nothing was going to move again. The transition's own
 * safety timer only starts once its first frames have come.
 */
export const TRANSITION_BLOQUEE_MS = 3_000

/** Has this transition, started `ecouleMs` ago and meant to last `dureeMs`, stuck? */
export function transitionBloquee(ecouleMs: number, dureeMs: number): boolean {
  return ecouleMs > dureeMs + TRANSITION_BLOQUEE_MS
}
