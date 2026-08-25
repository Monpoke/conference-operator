import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  STATUTS,
  decisionApplicable,
  refusDeTransition,
  statutApres,
  transitionAutorisee,
} from '../src/cycle-de-vie.js'

/**
 * La table est la règle, et elle n'a qu'un exemplaire.
 *
 * Elle existait deux fois sans le dire : la régie grisait « Terminer » sur une
 * conférence non lancée, la procédure du hub l'acceptait. Rien ne cassait — on
 * écrivait simplement `ended` sur un talk qui ne s'était pas tenu, et
 * l'historique mentait.
 */
describe('transitions du cycle de vie', () => {
  it('lance une conférence à venir, jamais deux fois', () => {
    expect(statutApres('scheduled', 'start')).toBe('running')
    expect(transitionAutorisee('running', 'start')).toBe(false)
  })

  it('rattrape une clôture prématurée sans passer par « Remettre à venir »', () => {
    // La règle horaire clôt un talk qui débordait mais n'était pas fini : le
    // relancer doit tenir en un geste, pas en deux.
    expect(statutApres('ended', 'start')).toBe('running')
  })

  it('ne termine que ce qui est lancé', () => {
    expect(statutApres('running', 'end')).toBe('ended')
    expect(transitionAutorisee('scheduled', 'end')).toBe(false)
    expect(transitionAutorisee('ended', 'end')).toBe(false)
  })

  it('laisse « Remettre à venir » ouvert depuis partout', () => {
    // C'est l'échappatoire : une échappatoire conditionnelle n'en est pas une.
    for (const statut of STATUTS) expect(statutApres(statut, 'reset')).toBe('scheduled')
  })

  it('dit ce qu’il en est plutôt que la règle enfreinte', () => {
    expect(refusDeTransition('running', 'start')).toContain('déjà lancée')
    expect(refusDeTransition('scheduled', 'end')).toContain("n'a pas été lancée")
    expect(refusDeTransition('ended', 'end')).toContain('déjà terminée')
    expect(refusDeTransition('scheduled', 'start')).toBeNull()
  })

  it('a un avis sur chaque couple, et un message pour chaque refus', () => {
    // Une action ajoutée sans ligne dans la table passerait pour autorisée si
    // on se contentait d'échantillonner quelques cas.
    for (const statut of STATUTS) {
      for (const action of ACTIONS) {
        const cible = statutApres(statut, action)
        expect(transitionAutorisee(statut, action)).toBe(cible != null)
        expect(refusDeTransition(statut, action) == null).toBe(cible != null)
      }
    }
  })
})

/**
 * La règle qui rend l'horloge simulée utilisable.
 *
 * Le hub l'appliquait seul, et le banc d'essai s'en passait : la même journée
 * rejouée y donnait deux réponses différentes selon qu'on l'avait déroulée
 * dans l'ordre ou en revenant en arrière.
 */
describe('décisions datées du futur', () => {
  const MIDI = Date.parse('2026-10-30T11:00:00Z')

  it('écarte ce qui n’a pas encore eu lieu', () => {
    expect(decisionApplicable(MIDI, MIDI - 60_000)).toBe(false)
  })

  it('garde ce qui vient d’avoir lieu, à la milliseconde près', () => {
    expect(decisionApplicable(MIDI, MIDI)).toBe(true)
    expect(decisionApplicable(MIDI - 1, MIDI)).toBe(true)
  })

  it('garde une décision qu’on ne sait pas situer', () => {
    // Un état qu'on ne sait pas dater est un problème de données, pas une
    // raison de le faire disparaître de l'historique.
    expect(decisionApplicable(null, MIDI)).toBe(true)
    expect(decisionApplicable(undefined, MIDI)).toBe(true)
    expect(decisionApplicable(Number.NaN, MIDI)).toBe(true)
  })
})
