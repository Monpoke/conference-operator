import type { DisplayPayload } from '@conference-operator/contract'

export type Data = DisplayPayload

/**
 * One scene of the stage.
 *
 * Mounted once, never removed: the reference loop keeps every scene in the
 * document, transparent, so that a scene coming in is already laid out and its
 * images already decoded. What moves is only which one is live.
 */
export interface Scene {
  el: HTMLElement
  /**
   * What of the payload the scene draws. A change marks it dirty; a dirty scene
   * is rebuilt **only off screen** — never in front of the room — unless it is
   * the one screen the operator put up, which follows its data in place.
   */
  cle(data: Data): unknown
  rendre(data: Data): void
  /** `false`: the loop skips it — there is nothing to show. */
  jouable(data: Data): boolean
  /** Every second, visible or not: the clock, the running slot. */
  tick?(data: Data, now: number): void
  /** Just after it has left the screen. */
  quitte?(data: Data): void
  /** Set by `tick` when the scene wants rebuilding (a session just ended). */
  sale?: boolean
  /** A message shown when the operator puts it up with nothing in it. */
  vide?: string
}
