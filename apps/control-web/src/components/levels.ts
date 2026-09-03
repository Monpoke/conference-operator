/**
 * The levels, from the calmest to the gravest.
 *
 * "unknown" is not among them: it is not a severity, it is a missing measurement.
 * Confusing it with "ok" would make a machine one failed to read look like a
 * machine at rest.
 */
export const SEVERITY = ['ok', 'warn', 'alert'] as const

export type Level = 'ok' | 'warn' | 'alert' | 'unknown'

/**
 * The worse of two levels — what the header dot must show.
 *
 * "unknown" wins over nothing: a missing measurement must not put out the alert
 * the other one is raising.
 */
export function worst(a: Level, b: Level): Level {
  const rank = (level: Level): number => SEVERITY.indexOf(level as (typeof SEVERITY)[number])
  if (rank(a) < 0) return b
  if (rank(b) < 0) return a
  return rank(a) >= rank(b) ? a : b
}
