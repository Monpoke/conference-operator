/// <reference lib="dom" />
// La lib DOM est déclarée ici seulement : l'ajouter au tsconfig laisserait le
// code serveur appeler `document` sans que rien ne proteste.
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { attendreRendu } from './helpers/attendre.js'
import { aplatirCouchesHtml } from '@cloudnord/ui'
import { renderWallPage } from '../src/pages/wall-page.js'

/**
 * Le mur public, exécuté dans un vrai DOM.
 *
 * C'est la seule page que le public utilise, sur son propre téléphone : elle
 * n'a pas d'étape de build, et une erreur dans son script la laisse muette
 * sans rien signaler.
 */
const SALLE = { id: 'track-1', name: 'Track #1' }

const TALK = {
  id: 'ses-1',
  title: 'HoneySwamp',
  speakers: ['Steven LE ROUX'],
  startsAt: '2026-10-30T10:00:00.000Z',
  endsAt: '2026-10-30T10:50:00.000Z',
}

let appels: { chemin: string; entree: Record<string, unknown> }[]

/**
 * Monte le mur avec un hub simulé.
 *
 * `courant` est ce que renvoie `rooms/current` ; `questions` ce que renvoie
 * `questions/list`, quelle que soit la conférence demandée — c'est justement
 * l'entrée de cet appel qu'on vient observer.
 */
function monterMur(
  courant: { current: unknown; next: unknown },
  questions: unknown[] = [],
  murRecent: unknown[] = [],
): void {
  appels = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const chemin = String(url).replace('/rpc/', '')
    appels.push({ chemin, entree: JSON.parse(String(init.body)).json })
    const json = chemin === 'rooms/current' ? courant
      : chemin === 'questions/list' ? questions
        : chemin === 'wall/recent' ? murRecent
          : {}
    return new Response(JSON.stringify({ json }), { status: 200 })
  }))

  document.documentElement.innerHTML = aplatirCouchesHtml(
    renderWallPage({ roomId: SALLE.id, rooms: [SALLE] }),
  )
  for (const script of document.querySelectorAll('script:not([type])')) {
    // eslint-disable-next-line no-new-func
    new Function(script.textContent ?? '')()
  }
}

const $ = (id: string) => document.getElementById(id)!
const attendre = attendreRendu

beforeEach(() => {
  localStorage.clear()
})

/**
 * Questions bornées au talk.
 *
 * À 16 h, la liste remontait encore celles du talk de 10 h — les mieux votées,
 * donc en tête — et le public votait pour des questions que plus personne ne
 * poserait.
 */
describe('mur — questions du talk en cours', () => {
  it('ne demande que les questions de la conférence en cours', async () => {
    monterMur({ current: TALK, next: null })
    await attendre()
    $('onglet-questions').click()
    await attendre()

    expect(appels).toContainEqual({
      chemin: 'questions/list',
      entree: { roomId: SALLE.id, sessionId: TALK.id },
    })
    // Et jamais avec `sessionId: null`, qui vaut « toute la journée » côté hub.
    expect(appels.some((appel) =>
      appel.chemin === 'questions/list' && appel.entree.sessionId === null)).toBe(false)
  })

  it('rattache une question posée à cette conférence', async () => {
    monterMur({ current: TALK, next: null })
    await attendre()
    ;($('question') as HTMLTextAreaElement).value = 'Et les faux positifs ?'
    $('form-question').dispatchEvent(new Event('submit'))
    await attendre()

    expect(appels.find((appel) => appel.chemin === 'questions/post')?.entree)
      .toMatchObject({ roomId: SALLE.id, sessionId: TALK.id })
  })

  it('vise la conférence à venir entre deux talks', async () => {
    // Une question posée pendant la pause qui précède un talk le vise. La
    // rattacher à rien la rendrait invisible de tous — régie comprise.
    monterMur({ current: null, next: TALK })
    await attendre()
    $('onglet-questions').click()
    await attendre()

    expect(appels).toContainEqual({
      chemin: 'questions/list',
      entree: { roomId: SALLE.id, sessionId: TALK.id },
    })
  })

  it('le dit quand aucune conférence n\'est annoncée', async () => {
    monterMur({ current: null, next: null })
    await attendre()
    $('onglet-questions').click()
    await attendre()

    expect($('liste-questions').textContent).toContain('Aucune conférence annoncée')
    expect(appels.some((appel) => appel.chemin === 'questions/list')).toBe(false)
  })

  it('nomme la conférence quand personne n\'a encore rien demandé', async () => {
    // « Aucune question » tout court laisserait croire que le mur est cassé.
    monterMur({ current: TALK, next: null }, [])
    await attendre()
    $('onglet-questions').click()
    await attendre()

    expect($('liste-questions').textContent).toContain('HoneySwamp')
  })
})

/**
 * Le mur est commun à l'événement.
 *
 * Un message du public s'adresse à Cloud Nord, pas à la pièce où son auteur se
 * trouve : le limiter à une salle en faisait un canal de plus à surveiller, et
 * privait les deux autres écrans de ce qui s'y disait.
 */
describe('mur — commun à toutes les salles', () => {
  const MESSAGE = {
    id: 'c-1', source: 'form', author: 'Camille', authorHandle: null,
    text: 'Super talk, merci !', status: 'approved', roomId: null, sessionId: null,
    createdAt: '2026-10-30T10:05:00.000Z',
  }

  it('dépose sans salle, quelle que soit celle qui est choisie', async () => {
    monterMur({ current: TALK, next: null })
    await attendre()
    ;($('auteur') as HTMLInputElement).value = 'Camille'
    ;($('message') as HTMLTextAreaElement).value = 'Super talk'
    $('form-message').dispatchEvent(new Event('submit'))
    await attendre()

    // Côté hub, une salle nulle vaut « toutes les salles ».
    expect(appels.find((appel) => appel.chemin === 'wall/post')?.entree)
      .toMatchObject({ roomId: null, author: 'Camille' })
  })

  it('annonce la portée avant le formulaire, pas après', async () => {
    // C'est la promesse de la page : on n'écrit pas dans une boîte à idées.
    // Le dire sous un bouton qu'on vient d'appuyer revenait à ne pas le dire.
    monterMur({ current: TALK, next: null })
    await attendre()

    expect($('vue-mur').textContent).toContain('dans toutes les salles')
    // Le nombre réel de salles, pas un principe.
    expect($('portee').textContent).toContain("Projeté sur les écrans")
  })

  it('montre ce qui est déjà à l\'écran', async () => {
    // Sans ça, déposer un message revenait à parler dans le vide : rien ne
    // montrait que d'autres écrivaient, ni que ça finissait projeté.
    monterMur({ current: TALK, next: null }, [], [MESSAGE])
    await attendre()

    expect(appels.some((appel) => appel.chemin === 'wall/recent')).toBe(true)
    expect($('liste-mur').textContent).toContain('Super talk, merci !')
    expect($('liste-mur').textContent).toContain('Camille')
  })

  it('invite plutôt que de laisser un cadre vide', async () => {
    monterMur({ current: TALK, next: null }, [], [])
    await attendre()

    expect($('liste-mur').textContent).toContain('peut être le vôtre')
  })

  it('ne laisse plus le nom d\'une salle en tête du mur', async () => {
    // Il laissait croire qu'on écrivait à cette salle-là.
    monterMur({ current: TALK, next: null })
    await attendre()

    expect($('salle').textContent).toContain('Questions')
  })
})
