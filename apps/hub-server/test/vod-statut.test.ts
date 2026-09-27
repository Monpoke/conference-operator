import { describe, expect, it } from 'vitest'
import { vodStatut } from '../src/services/vod-statut.js'

/**
 * One talk's capture, in one word.
 *
 * Read from the furthest step reached; a running take and a failure come first,
 * because those are the two that wait for someone.
 */
describe('where a talk s capture stands', () => {
  const take = { enCours: false }
  const done = { state: 'termine' as const }

  it('says there is nothing when nothing was taken', () => {
    expect(vodStatut({ captations: [], televersements: [], montage: null }).statut).toBe('aucune')
  })

  it('follows the capture along its path', () => {
    expect(vodStatut({ captations: [take], televersements: [], montage: null }).statut).toBe('sur-la-machine')
    expect(vodStatut({ captations: [take], televersements: [{ state: 'en-cours' }, done], montage: null }).statut).toBe(
      'televersement',
    )
    expect(vodStatut({ captations: [take], televersements: [done, done], montage: null }).statut).toBe('sur-le-stockage')
    expect(vodStatut({ captations: [take], televersements: [done], montage: { state: 'en-cours' } }).statut).toBe('montage')
    expect(vodStatut({ captations: [take], televersements: [done], montage: { state: 'a-valider' } }).statut).toBe('a-valider')
    expect(vodStatut({ captations: [take], televersements: [done], montage: { state: 'termine' } }).statut).toBe('prete')
  })

  it('says a take is running whatever came before', () => {
    // The talk is on air again: a previous montage is not what matters now.
    expect(
      vodStatut({ captations: [take, { enCours: true }], televersements: [done], montage: { state: 'termine' } }).statut,
    ).toBe('en-cours')
  })

  it('says a failure wherever it happened', () => {
    expect(vodStatut({ captations: [take], televersements: [done], montage: { state: 'echoue' } })).toEqual({
      statut: 'erreur',
      detail: 'Montage en échec',
    })
    expect(vodStatut({ captations: [take], televersements: [{ state: 'abandonne' }, done], montage: null })).toEqual({
      statut: 'erreur',
      detail: 'Téléversement en échec',
    })
  })

  it('reads a cancelled montage as no montage', () => {
    expect(vodStatut({ captations: [take], televersements: [done], montage: { state: 'annule' } }).statut).toBe(
      'sur-le-stockage',
    )
  })
})
