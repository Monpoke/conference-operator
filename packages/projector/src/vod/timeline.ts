/**
 * How long the VOD's two clips last.
 *
 * Shared by the page that draws them and by the renderer that counts frames:
 * the renderer must not guess, and the page must not run past what is captured.
 * Pure, with no DOM, so both sides can import it.
 */

export const INTRO_MS = 6_000

/**
 * The outro: every sponsor on one frame, tiers stacked. One frame rather than
 * the loop's pages in turn — four tiers at three seconds each made a fifteen
 * second outro that viewers skip before the sponsors they came to thank.
 */
export const OUTRO_MS = 8_000

/** The fade to black that closes the video. */
export const OUTRO_SORTIE_MS = 1_300
