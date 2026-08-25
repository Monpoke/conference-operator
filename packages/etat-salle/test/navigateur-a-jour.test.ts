import { describe, expect, it } from 'vitest'
// @ts-expect-error — script de build en JS pur, sans typage dédié
import { compilerNavigateur, securiser } from '../scripts/build-navigateur.mjs'
import { MACHINE_JS } from '../src/generated/navigateur.js'
import { FIN_PROCHE_MS, RETARD_MS, etatDesCreneaux } from '../src/conference.js'

/**
 * Le module committé doit correspondre au code de l'automate.
 *
 * C'est le garde-fou qui donne son sens au paquet. Sans lui, une règle changée
 * dans `src/` laisserait les pages tourner sur la compilation précédente : le
 * hub appliquerait le nouveau seuil, la régie l'ancien, et on aurait rebâti à
 * grands frais exactement la divergence qu'on venait de supprimer — en pire,
 * puisque plus personne ne la chercherait à deux endroits.
 *
 * Recompiler coûte quelques dizaines de millisecondes, donc on compare pour de
 * vrai plutôt que d'échantillonner quelques symboles.
 */
describe('automate inliné dans les pages', () => {
  it("correspond au code du paquet", () => {
    expect(
      securiser(compilerNavigateur()) === MACHINE_JS,
      'Le module committé diffère d’une recompilation : l’automate a changé sans ' +
        'être régénéré, et les pages tournent sur l’ancienne version.\n' +
        '    pnpm --filter @cloudnord/etat-salle build',
    ).toBe(true)
  })

  it('expose ce que les pages appellent', () => {
    // Garde-fou du garde-fou : une compilation vide passerait la comparaison
    // ci-dessus en ne prouvant rien.
    for (const symbole of [
      'etatDesCreneaux',
      'conferenceAPiloter',
      'pauseDesCreneaux',
      'finEffectiveA',
      'apparenceDe',
      'etatFaisantFoi',
      'transitionAutorisee',
      'refusDeTransition',
      'timelinePosition',
    ]) {
      expect(MACHINE_JS).toContain(symbole)
    }
  })

  it("n'embarque pas les schémas du programme", () => {
    /**
     * La racine de `@cloudnord/program` réexporte zod : l'importer depuis
     * l'entrée navigateur inlinait six cents kilo-octets dans chaque page, pour
     * trois fonctions d'horaire. Le seuil laisse de la marge à l'automate tout
     * en attrapant le retour de la bibliothèque entière.
     */
    expect(MACHINE_JS.length).toBeLessThan(60_000)
    expect(MACHINE_JS).not.toContain('ZodError')
  })

  it("ne peut pas refermer la balise script de la page qui l'inline", () => {
    expect(MACHINE_JS).not.toMatch(/<\/script>/i)
  })

  it('répond comme le module source, une fois exécuté', () => {
    /**
     * Le vrai garde-fou : on exécute le bundle et on lui repose les questions.
     *
     * Comparer les textes attrape une régénération oubliée ; seule l'exécution
     * attrape une entrée navigateur qui aurait cessé d'exporter ce dont les
     * pages dépendent, ou un seuil que la compilation aurait réécrit. C'est
     * cette égalité-là — même réponse dans la page et dans le hub — que le
     * paquet promet.
     */
    const machine = new Function(`${MACHINE_JS}; return EtatSalle`)() as {
      FIN_PROCHE_MS: number
      RETARD_MS: number
      etatDesCreneaux: typeof etatDesCreneaux
      apparenceDe: (etat: string) => { mot: string }
      transitionAutorisee: (depuis: string, action: string) => boolean
    }

    expect(machine.FIN_PROCHE_MS).toBe(FIN_PROCHE_MS)
    expect(machine.RETARD_MS).toBe(RETARD_MS)

    // Un talk de 10:00 à 10:50, personne ne l'a lancé : « retard » passé 10:05.
    const creneaux = [
      { id: 'a', kind: 'talk' as const, startsAtMs: 0, endsAtMs: 50 * 60_000, durationMinutes: 50 },
    ]
    for (const minute of [1, 6, 30, 51]) {
      const instant = minute * 60_000
      expect(machine.etatDesCreneaux(creneaux, instant), `à ${minute} min`).toBe(
        etatDesCreneaux(creneaux, instant),
      )
    }
    expect(machine.etatDesCreneaux(creneaux, 6 * 60_000, { a: 'running' })).toBe('en-cours')

    expect(machine.apparenceDe('depassement').mot).toBe('dépassement')
    expect(machine.transitionAutorisee('running', 'start')).toBe(false)
  })
})
