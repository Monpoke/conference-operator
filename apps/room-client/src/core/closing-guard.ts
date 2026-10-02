import type { ObsState } from './obs.js'

/**
 * What closing the control window would leave running in OBS.
 *
 * Closing that window quits the room — and the room does not stop OBS on its way
 * out: it disconnects. The recording and the stream carry on, driven by nobody:
 * no more markers, no clean stop at the end of the talk, no rushes sent to the
 * hub. An operator who closes "to tidy up" in the middle of a take only finds
 * out the next morning, in the editing room. So the close asks first, loudly.
 *
 * Kept free of Electron, like `window-opening.ts`: the main process only shows
 * the dialog.
 */
export interface ClosingWarning {
  /** The headline: one line, read before anything else. */
  message: string
  /** What is running, one line each, then what closing does to it. */
  detail: string
}

/**
 * The warning to show, or `null` when nothing is running.
 *
 * Only a connected instance counts: a dropped one's last snapshot says what it
 * was doing before the cut, not now — and the room cannot drive it anyway.
 */
export function closingWarning(obs: { A: ObsState | null; B: ObsState | null }): ClosingWarning | null {
  const running: string[] = []
  for (const state of [obs.A, obs.B]) {
    if (state == null || !state.connected) continue
    const where = state.canvas === true ? 'captation (canevas d’OBS-A)' : `OBS-${state.instance}`
    if (state.recording) running.push(`• Enregistrement en cours — ${where}`)
    if (state.streaming) running.push(`• Diffusion en direct — ${where}`)
  }
  if (running.length === 0) return null

  return {
    message: '⚠ OBS est en train de travailler — fermer la régie arrête la salle',
    detail: [
      ...running,
      '',
      'OBS continuera sans personne pour le piloter : plus de marqueurs, pas d’arrêt propre ' +
        'en fin de conférence, aucun rush envoyé au hub.',
      '',
      'Arrêtez d’abord l’enregistrement et la diffusion depuis la régie, sauf si vous savez ' +
        'ce que vous faites.',
    ].join('\n'),
  }
}
