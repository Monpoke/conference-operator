import { describe, expect, it } from 'vitest'
import {
  IDENTITE_PAR_DEFAUT,
  nomCourtDeduit,
  resoudreIdentiteEvenement,
} from '../src/event-identity.js'

/**
 * Identité de l'événement.
 *
 * C'est la pièce qui rend le dépôt agnostique : rien n'écrit plus le nom d'un
 * événement en dur, et changer d'édition — ou d'événement — se réduit à
 * importer un autre programme. Ces tests portent donc sur l'ordre des sources,
 * qui est tout ce qui distingue « configurable » de « reconfigurable par
 * accident ».
 */
describe('identité de l’événement', () => {
  it('se déduit du programme importé, sans rien régler', () => {
    // Le cas normal, et le seul geste demandé pour servir un autre événement.
    expect(resoudreIdentiteEvenement({ programme: 'DevFest Lille 2027' })).toEqual({
      name: 'DevFest Lille 2027',
      shortName: 'DevFest Lille',
    })
  })

  it('laisse le réglage du hub contredire l’export amont', () => {
    // Pour les exports qui portent un nom interne, ou pas de nom du tout.
    expect(
      resoudreIdentiteEvenement({
        reglage: { name: 'Cloud Nord 2026', shortName: null },
        programme: 'CN26-prod',
      }),
    ).toEqual({ name: 'Cloud Nord 2026', shortName: 'Cloud Nord' })
  })

  it('déduit le nom court du nom retenu, pas d’une autre source', () => {
    // Régler le nom complet sans penser au court doit rester cohérent : sinon
    // la console afficherait le nouveau nom et les notifications l'ancien.
    const identite = resoudreIdentiteEvenement({
      reglage: { name: 'Sunny Tech 2027' },
      programme: 'Cloud Nord 2026',
    })
    expect(identite.shortName).toBe('Sunny Tech')
  })

  it('retient un nom court réglé à la main', () => {
    expect(
      resoudreIdentiteEvenement({ reglage: { name: 'Les Journées du Cloud', shortName: 'JDC' } }),
    ).toEqual({ name: 'Les Journées du Cloud', shortName: 'JDC' })
  })

  it('traite une chaîne vide comme une absence de réglage', () => {
    // La console envoie `null` en vidant un champ, mais un import amont peut
    // très bien porter `"name": ""` — les deux doivent relâcher la source.
    expect(resoudreIdentiteEvenement({ reglage: { name: '  ' }, programme: 'Cloud Nord 2026' }).name)
      .toBe('Cloud Nord 2026')
    expect(resoudreIdentiteEvenement({ programme: '' })).toEqual(IDENTITE_PAR_DEFAUT)
  })

  it('retombe sur un mot neutre quand rien n’est connu', () => {
    // Un hub tout juste installé, avant le premier import : mieux vaut un mot
    // neutre qu'un nom d'événement en dur, qui serait faux partout ailleurs.
    expect(resoudreIdentiteEvenement()).toEqual(IDENTITE_PAR_DEFAUT)
  })

  it('borne ce qui vient de l’export amont', () => {
    // Le nom traverse le `sync` de toutes les salles : un export fantaisiste ne
    // doit pas faire échouer leur validation, donc il est tronqué, pas refusé.
    const identite = resoudreIdentiteEvenement({ programme: 'x'.repeat(300) })
    expect(identite.name).toHaveLength(80)
    expect(identite.shortName).toHaveLength(40)
  })
})

describe('nom court', () => {
  it('retire ce qui date le nom', () => {
    expect(nomCourtDeduit('Cloud Nord 2026')).toBe('Cloud Nord')
    expect(nomCourtDeduit('DevFest Lille #12')).toBe('DevFest Lille')
    expect(nomCourtDeduit('Sunny Tech — 2027')).toBe('Sunny Tech')
    expect(nomCourtDeduit('Riviera DEV, édition 12')).toBe('Riviera DEV')
  })

  it('ne coupe que ce dont il est sûr', () => {
    // Volontairement timide : un nom court faux se lirait sur chaque écran de
    // la journée, un nom court trop long ne se remarque pas.
    expect(nomCourtDeduit('Web2Day')).toBe('Web2Day')
    expect(nomCourtDeduit('Codeurs en Seine')).toBe('Codeurs en Seine')
    // Un nom qui n'est que son millésime ne se raccourcit pas à rien.
    expect(nomCourtDeduit('2026')).toBe('2026')
  })
})
