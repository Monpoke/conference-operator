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
              `Migration(s) publiée(s) ${anomalies.map((a: { problem: string }) => a.problem).join(', ')} dans migrations/${set} :`,
              ...anomalies.map((a: { tag: string; problem: string }) => `  ${a.tag} — ${a.problem}`),
              '',
              "Une migration publiée ne se modifie pas : ajoutez-en une nouvelle.",
              '  git checkout -- packages/db/migrations',
              `  pnpm --filter @cloudnord/db generate:${set}`,
              '',
              "Si la modification est délibérée et qu'aucune base n'existe ailleurs :",
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
