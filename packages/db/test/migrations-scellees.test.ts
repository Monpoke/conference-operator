import { describe, expect, it } from 'vitest'
// @ts-expect-error — script utilitaire en JS pur, sans typage dédié
import { JEUX, verifier } from '../scripts/empreintes.mjs'

/**
 * Régénérer une migration déjà publiée casse toute base existante : Drizzle ne
 * reconnaît plus le hash, rejoue les CREATE TABLE et échoue. Pendant le
 * développement, la seule issue a été de supprimer la base du hub — donc les
 * comptes opérateurs, les appairages et l'historique de modération.
 *
 * Ce test transforme cette convention en échec de build, avant qu'une base
 * ailleurs que sur le poste du développeur ne soit concernée.
 */
describe('migrations scellées', () => {
  for (const jeu of JEUX as string[]) {
    it(`${jeu} : aucune migration publiée n'a été modifiée`, () => {
      const { anomalies } = verifier(jeu)
      expect(
        anomalies,
        anomalies.length === 0
          ? ''
          : [
              `Migration(s) publiée(s) ${anomalies.map((a: { probleme: string }) => a.probleme).join(', ')} dans migrations/${jeu} :`,
              ...anomalies.map((a: { tag: string; probleme: string }) => `  ${a.tag} — ${a.probleme}`),
              '',
              "Une migration publiée ne se modifie pas : ajoutez-en une nouvelle.",
              '  git checkout -- packages/db/migrations',
              `  pnpm --filter @cloudnord/db generate:${jeu}`,
              '',
              "Si la modification est délibérée et qu'aucune base n'existe ailleurs :",
              '  pnpm --filter @cloudnord/db sceller',
            ].join('\n'),
      ).toEqual([])
    })
  }

  it('une migration nouvelle est acceptée sans être une anomalie', () => {
    for (const jeu of JEUX as string[]) {
      const { nouvelles } = verifier(jeu)
      // Rien de non scellé ici, mais la distinction doit exister : ajouter une
      // migration est le geste normal, et ne doit jamais faire échouer le build.
      expect(Array.isArray(nouvelles)).toBe(true)
    }
  })
})
