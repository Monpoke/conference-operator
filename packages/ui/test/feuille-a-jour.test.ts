import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — script de build en JS pur, sans typage dédié
import { compilerCss, securiser } from '../scripts/build-css.mjs'
import { TAILWIND_CSS } from '../src/generated/styles.js'

/**
 * La feuille committée doit correspondre aux classes réellement employées.
 *
 * Le risque est silencieux : une classe Tailwind ajoutée dans une page sans
 * régénérer la feuille n'a tout simplement aucun style. Rien ne lève, rien ne
 * casse au typage — l'écran s'affiche de travers, et on le découvre en salle.
 *
 * Recompiler coûte quelques dizaines de millisecondes, donc on compare pour de
 * vrai plutôt que d'échantillonner quelques noms de classes.
 */
describe('feuille de style', () => {
  it('est à jour vis-à-vis des pages', () => {
    const fraiche = securiser(compilerCss(join(mkdtempSync(join(tmpdir(), 'cn-css-')), 'styles.css')))
    expect(
      fraiche === TAILWIND_CSS,
      "La feuille committée diffère d'une recompilation : une page utilise des classes " +
        'qui ne sont pas dans le CSS servi (ou plus aucune ne les utilise).\n' +
        '    pnpm --filter @cloudnord/ui build',
    ).toBe(true)
  })

  it('contient les utilitaires et le thème', () => {
    // Garde-fou du garde-fou : une compilation vide passerait la comparaison
    // ci-dessus en ne prouvant rien.
    expect(TAILWIND_CSS.length).toBeGreaterThan(5_000)
    expect(TAILWIND_CSS).toContain('--color-attenue')
    expect(TAILWIND_CSS).toMatch(/\.flex\{/)
  })

  it("ne peut pas refermer la balise style de la page qui l'inline", () => {
    expect(TAILWIND_CSS).not.toMatch(/<\/style>/i)
  })
})
