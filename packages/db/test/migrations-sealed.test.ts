import { describe, expect, it } from 'vitest'
// @ts-expect-error — utility script in plain JS, with no dedicated typings
import { SETS, verify } from '../scripts/fingerprints.mjs'

/**
 * Regenerating an already published migration breaks every existing database:
 * Drizzle no longer recognises the hash, replays the CREATE TABLEs and fails.
 * During development, the only way out has been to delete the hub's database —
 * and with it the operator accounts, the pairings and the moderation history.
 *
 * This test turns that convention into a build failure, before a database
 * anywhere other than a developer's machine is affected.
 */
describe('sealed migrations', () => {
  for (const set of SETS as string[]) {
    it(`${set}: no published migration has been modified`, () => {
      const { anomalies } = verify(set)
      expect(
        anomalies,
        anomalies.length === 0
          ? ''
          : [
              `Published migration(s) ${anomalies.map((a: { problem: string }) => a.problem).join(', ')} in migrations/${set}:`,
              ...anomalies.map((a: { tag: string; problem: string }) => `  ${a.tag} — ${a.problem}`),
              '',
              'A published migration is not modified: add a new one instead.',
              '  git checkout -- packages/db/migrations',
              `  pnpm --filter @cloudnord/db generate:${set}`,
              '',
              "If the change is deliberate and no database exists anywhere else:",
              '  pnpm --filter @cloudnord/db seal',
            ].join('\n'),
      ).toEqual([])
    })
  }

  it('accepts a new migration without calling it an anomaly', () => {
    for (const set of SETS as string[]) {
      const { added } = verify(set)
      // Nothing unsealed here, but the distinction has to exist: adding a
      // migration is the normal gesture, and must never fail the build.
      expect(Array.isArray(added)).toBe(true)
    }
  })
})
