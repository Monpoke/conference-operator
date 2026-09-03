/// <reference lib="dom" />
// La lib DOM est déclarée ici seulement : l'ajouter au tsconfig laisserait le
// code serveur appeler `document` sans que rien ne proteste.
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { flattenLayersInHtml } from '@cloudnord/ui'
import { renderOverlayPage } from '../src/core/overlay-page.js'
import type { DisplayPayload } from '../src/core/display-server.js'

/**
 * Habillage de captation.
 *
 * Ce qui est dans cette page est **incrusté dans le master** : elle est une
 * source de la scène d'OBS-B, donc tout ce qu'elle affiche part dans la VOD et
 * dans le direct. C'est la seule contrainte qui compte ici.
 */
const TALK = {
  id: 'ses-1',
  title: 'HoneySwamp: Active Defense to Ruin Attackers',
  kind: 'talk',
  startsAt: '2026-10-30T10:00:00.000Z',
  endsAt: '2026-10-30T10:50:00.000Z',
  startsAtMs: Date.parse('2026-10-30T10:00:00Z'),
  endsAtMs: Date.parse('2026-10-30T10:50:00Z'),
  speakers: [{ name: 'Steven LE ROUX', company: 'Clever Cloud' }],
  category: null,
}

const ETAT = {
  state: {
    mode: 'sponsors',
    currentSession: TALK,
    nextSession: null,
    recording: false,
    streaming: false,
    serverTimeOffsetMs: 0,
    comments: [],
    sessionStates: {},
  },
  event: null,
} as unknown as DisplayPayload

function monterHabillage(payload: DisplayPayload = ETAT): void {
  document.documentElement.innerHTML = flattenLayersInHtml(
    renderOverlayPage({ initialPayload: payload }),
  )
  for (const script of document.querySelectorAll('script:not([type])')) {
    // eslint-disable-next-line no-new-func
    new Function(script.textContent ?? '')()
  }
}

describe('habillage de captation', () => {
  it('titre la conférence en cours', () => {
    monterHabillage()

    expect(document.body.dataset.titrage).toBe('visible')
    expect(document.getElementById('titre')?.textContent).toContain('HoneySwamp')
    expect(document.getElementById('personnes')?.textContent).toContain('Clever Cloud')
  })

  it('ne titre pas une pause', () => {
    // Un créneau sans intervenant n'a rien à titrer — et le titrage resterait
    // à l'écran pendant tout le déjeuner.
    monterHabillage({
      ...ETAT,
      state: { ...ETAT.state, currentSession: { ...TALK, kind: 'break', title: 'Déjeuner' } },
    } as unknown as DisplayPayload)

    expect(document.body.dataset.titrage).toBe('masque')
  })

  it('titre sans ligne vide quand personne n\'est encore annoncé', () => {
    /**
     * Le cas existe depuis qu'un créneau peut être déclaré conférence à la
     * main : une keynote d'ouverture dont le speaker n'est pas encore annoncé
     * porte un titre et aucun nom. Une ligne vide garderait sa marge sous le
     * titre et se lirait, dans le direct comme dans la VOD, comme un nom qui
     * n'a pas chargé.
     */
    monterHabillage({
      ...ETAT,
      state: {
        ...ETAT.state,
        currentSession: { ...TALK, title: "Keynote d'ouverture", speakers: [] },
      },
    } as unknown as DisplayPayload)

    expect(document.body.dataset.titrage).toBe('visible')
    expect(document.getElementById('titre')?.textContent).toContain('Keynote')
    expect(document.getElementById('personnes')?.hidden).toBe(true)
  })

  it('ne signale pas l\'enregistrement, même en pleine prise', () => {
    // Un point rouge ici serait gravé dans la VOD livrée. Le témoin de prise
    // vit en régie, panneau « Captation ».
    monterHabillage({
      ...ETAT,
      state: { ...ETAT.state, recording: true },
    } as unknown as DisplayPayload)

    expect(document.getElementById('rec')).toBeNull()
    expect(document.body.dataset.rec).toBeUndefined()
  })
})

/**
 * Question du public dans le master.
 *
 * Elle **a** sa place dans la VOD : une captation où le speaker répond à une
 * question qu'on n'a jamais lue est incompréhensible. Le bandeau de la console,
 * lui, n'y a pas sa place — il parle à la salle de maintenant. Les deux ont
 * longtemps partagé un seul champ, ce qui interdisait de montrer l'un sans
 * risquer l'autre.
 */
describe('question du public sur la captation', () => {
  const avec = (etat: Record<string, unknown>) =>
    ({ ...ETAT, state: { ...ETAT.state, ...etat } }) as unknown as DisplayPayload

  it('incruste la question mise à l\'antenne', () => {
    monterHabillage(avec({ question: { text: 'Et les faux positifs ?', author: 'Camille', sessionId: 'ses-1' } }))

    expect(document.body.dataset.question).toBe('visible')
    expect(document.getElementById('question-text')?.textContent).toBe('Et les faux positifs ?')
    expect(document.getElementById('question-auteur')?.textContent).toBe('Camille')
  })

  it('n\'incruste rien sans question à l\'antenne', () => {
    // Un cadre vide gravé dans toute la VOD serait pire que rien.
    monterHabillage(avec({ question: null }))

    expect(document.body.dataset.question).toBe('masque')
  })

  it('ne laisse jamais passer le bandeau de la console', () => {
    // « On reprend dans 5 minutes » gravé dans la VOD d'un talk : c'est
    // exactement ce que la séparation des deux channels évite.
    monterHabillage(avec({
      question: null,
      liveMessage: { text: 'Reprise dans 5 minutes', level: 'urgent', expiresAtMs: null },
    }))

    expect(document.body.dataset.question).toBe('masque')
    // Rien n'est *rendu* : l'état complet transite bien jusqu'ici, comme pour
    // les autres champs, mais cette page ne dessine que la question.
    expect(document.getElementById('question-text')?.textContent).toBe('')
    expect(document.getElementById('titre')?.textContent).not.toContain('Reprise')
  })

  it('reste visible hors talk titrable', () => {
    // Le titrage sort par un retour anticipé sur un créneau sans intervenant :
    // la question, elle, ne doit pas rester figée sur la précédente.
    monterHabillage(avec({
      currentSession: null,
      question: { text: 'Et les faux positifs ?', author: null, sessionId: 'ses-1' },
    }))

    expect(document.body.dataset.titrage).toBe('masque')
    expect(document.body.dataset.question).toBe('visible')
  })
})
