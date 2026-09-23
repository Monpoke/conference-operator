/**
 * The loop panels' field styles, written once.
 *
 * The settings view repeats them inline; here there are some fifty fields over
 * ten panels, and one class string drifting from the others is how a form ends
 * up with three input heights.
 */
export const LABEL = 'mb-[5px] block text-xs text-dim'
export const FIELD =
  'mb-[11px] w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text focus:border-brand focus:outline-none'
export const SMALL =
  'min-w-0 rounded-lg border border-edge bg-canvas px-2 py-1.5 text-sm text-text focus:border-brand focus:outline-none'
export const BOX = 'mb-2 rounded-lg border border-edge p-2.5'
export const SUBTITLE = 'mb-1.5 text-[11px] font-semibold tracking-[.14em] text-dim uppercase'

/** Emptied means "none": the contract wants `null`, never an empty string. */
export function orNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}
