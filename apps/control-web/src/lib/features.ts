import type { DisplayPayload, RoomScreen } from '@conference-operator/contract'

/**
 * The public wall and the questions, as the hub left them.
 *
 * Absent — an older room — means both on: what it did before the switch existed.
 */
export function featuresOf(payload: DisplayPayload): { wall: boolean; questions: boolean } {
  return payload.features ?? { wall: true, questions: true }
}

/**
 * The withdrawn screens, plus those a switched-off feature takes along.
 *
 * Folded into the same list rather than a second prop: the screen panel already
 * knows how to drop a withdrawn button — and to keep the one on air, so a room
 * showing the wall when the hub turns it off keeps its button until it moves on.
 *
 * - "Question choisie" goes with the questions;
 * - "Mur & questions" goes when both are off — with either one on, the scene still
 *   has something to show and a QR code to send people to.
 */
export function withdrawnScreens(payload: DisplayPayload): RoomScreen[] {
  const { wall, questions } = featuresOf(payload)
  const withdrawn = new Set<RoomScreen>(payload.screensDisabled)
  if (!questions) withdrawn.add('question')
  if (!wall && !questions) withdrawn.add('wall')
  return [...withdrawn]
}
