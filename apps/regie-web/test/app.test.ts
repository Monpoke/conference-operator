import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlDiagnostics } from '@cloudnord/contract'
import { NO_EDITING_MARKS } from '@cloudnord/contract'
import App from '../src/App.vue'
import { useConferenceStore } from '../src/stores/conference.js'
import { useConsultStore } from '../src/stores/consult.js'
import { useRoomStore } from '../src/stores/room.js'
import { payload } from './fixtures.js'

/**
 * La page entière, et les raccourcis qui la traversent.
 *
 * Ce qui se vérifie ici et nulle part ailleurs : qu'une lettre tapée dans la
 * salle atteigne bien la bonne commande. Deux d'entre elles basculent la
 * projection devant du public.
 */

interface Envoi {
  url: string
  body: unknown
}

let envois: Envoi[]
let appels: number

/*
 * Montée puis démontée, sans exception.
 *
 * La couche clavier pose un écouteur sur le `document` : un composant laissé
 * monté d'un test au suivant garde le sien, et ses liaisons pointent sur la
 * salle du test précédent. Une frappe partait alors deux fois, dont une vers
 * une captation qui n'existait plus.
 */
const montees: { unmount: () => void }[] = []

function fluxMuet(): void {
  vi.stubGlobal(
    'EventSource',
    class {
      onopen: unknown = null
      onerror: unknown = null
      onmessage: unknown = null
      addEventListener(): void {}
      close(): void {}
    },
  )
}

beforeEach(() => {
  setActivePinia(createPinia())
  envois = []
  fluxMuet()
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    envois.push({ url, body: init?.body == null ? null : JSON.parse(String(init.body)) })
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    })
  })
})

async function monter(
  recording: ControlDiagnostics['recording'] | null = null,
): Promise<ReturnType<typeof mount>> {
  const etat = payload()
  etat.diagnostics!.recording = recording ?? { active: false, markers: 0, startedAtMs: null, startedAtCorrectedMs: null, editing: NO_EDITING_MARKS }
  useRoomStore().seed(etat)
  const wrapper = mount(App, { attachTo: document.body })
  montees.push(wrapper)
  await flushPromises()
  return wrapper
}

afterEach(() => {
  for (const montee of montees.splice(0)) montee.unmount()
})

function frappe(key: string): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

describe('raccourcis de la page', () => {
  it('bascule la projection sans passer par la souris', async () => {
    await monter()

    frappe('l')
    frappe('h')
    await flushPromises()

    // Dans une salle sombre, viser un bouton coûte plus cher qu'appuyer sur une
    // touche — et ces deux-là se tapent pendant qu'on tient le micro.
    expect(envois.filter((envoi) => envoi.url === '/control/action').map((e) => e.body)).toEqual([
      { action: 'scene.set', role: 'LIVE' },
      { action: 'scene.set', role: 'HOLD' },
    ])
  })

  it('lance la captation quand rien ne tourne', async () => {
    await monter()

    frappe('r')
    await flushPromises()

    expect(envois.at(-1)?.body).toEqual({ action: 'recording.start' })
  })

  it('arrête celle qui tourne', async () => {
    await monter({ active: true, markers: 0, startedAtMs: 0, startedAtCorrectedMs: null, editing: NO_EDITING_MARKS })

    frappe('r')
    await flushPromises()

    expect(envois.at(-1)?.body).toEqual({ action: 'recording.stop' })
  })

  it('pose un marqueur pendant une prise', async () => {
    await monter({ active: true, markers: 0, startedAtMs: 0, startedAtCorrectedMs: null, editing: NO_EDITING_MARKS })

    frappe('m')
    await flushPromises()

    expect(envois.at(-1)?.body).toEqual({ action: 'recording.mark', label: 'Chapitre' })
  })

  it('pose les deux repères de editing au clavier', async () => {
    await monter({ active: true, markers: 0, startedAtMs: 0, startedAtCorrectedMs: null, editing: NO_EDITING_MARKS })

    // Ce sont des gestes qu'on fait en regardant la salle, pas l'écran :
    // l'orateur commence, l'orateur finit. Passer par le champ de libellé
    // ferait rater l'instant, qui est ici toute l'information.
    frappe('d')
    await flushPromises()
    expect(envois.at(-1)?.body).toEqual({ action: 'recording.mark', label: 'Début', role: 'debut' })

    frappe('f')
    await flushPromises()
    expect(envois.at(-1)?.body).toEqual({ action: 'recording.mark', label: 'Fin', role: 'fin' })
  })

  it('ne pose pas de repère quand rien n’enregistre', async () => {
    await monter()

    frappe('d')
    frappe('f')
    await flushPromises()

    expect(envois.filter((envoi) => envoi.url === '/control/action')).toEqual([])
  })

  it('ne pose pas de marqueur quand rien n’enregistre', async () => {
    await monter()

    frappe('m')
    await flushPromises()

    // Le poste refuserait la commande : l'envoyer quand même ferait clignoter
    // un échec pour un geste que la page savait impossible.
    expect(envois.filter((envoi) => envoi.url === '/control/action')).toEqual([])
  })

  it('rend la frappe au champ qui l’attend', async () => {
    const wrapper = await monter()
    const champ = wrapper.get('#message-text')

    await champ.setValue('l')
    champ.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }))
    await flushPromises()

    // Écrire « le micro coupe » dans le message à la console ne doit pas
    // basculer la projection en direct au premier caractère.
    expect(envois.filter((envoi) => envoi.url === '/control/action')).toEqual([])
  })
})

describe('titre de la fenêtre', () => {
  it('suit l’événement, et se corrige à un sync', async () => {
    await monter()
    expect(document.title).toBe('Régie — Cloud Nord 2026')

    useRoomStore().payload!.eventIdentity = { name: 'Cloud Nord 2027', shortName: 'CN27' }
    await flushPromises()

    // C'est la même machine qui servira l'édition suivante, et la barre de
    // fenêtre est le premier endroit où un nom périmé se remarque.
    expect(document.title).toBe('Régie — Cloud Nord 2027')
  })
})

describe('programmes des salles voisines', () => {
  it('ne les relit pas tant que l’empreinte du programme ne change pas', async () => {
    await monter()
    appels = envois.filter((envoi) => envoi.url.startsWith('/display/sessions')).length

    // Un état arrive toutes les quelques secondes ; relire une dizaine de
    // programmes à chaque fois coûterait autant de requêtes pour une réponse
    // identique.
    useRoomStore().payload!.state.outboxDepth = 3
    await flushPromises()

    expect(envois.filter((envoi) => envoi.url.startsWith('/display/sessions'))).toHaveLength(appels)
  })

  it('ne charge la liste qu’une fois au editing', async () => {
    await monter()

    // Un effet qui suit ce qu'il écrit se déclenche deux fois : le second tour
    // ne coûte rien de visible, mais il double les requêtes de la journée sur
    // une machine qui n'a rien demandé.
    expect(envois.filter((envoi) => envoi.url === '/display/sessions')).toHaveLength(1)
  })
})

describe('régie en lecture seule', () => {
  it('se monte sans diagnostic, plutôt que d’échouer', async () => {
    const etat = payload({ diagnostics: null })
    useRoomStore().seed(etat)
    const wrapper = mount(App, { attachTo: document.body })
    montees.push(wrapper)
    await flushPromises()

    // Une deuxième fenêtre ouverte pour regarder : le poste ne pilote rien, et
    // la moitié de la charge utile est absente.
    expect(wrapper.text()).toContain('Régie en lecture seule')
    expect(wrapper.find('#btn-rec').exists()).toBe(true)
  })
})

describe('consultation', () => {
  it('s’ouvre au clavier, sur l’onglet que la touche nomme', async () => {
    await monter()
    const consult = useConsultStore()

    frappe('p')
    await flushPromises()
    expect(consult.open).toBe(true)
    expect(consult.tab).toBe('programme')

    consult.open = false
    // La couche de la modale se retire au prochain cycle réactif : taper dans
    // l'intervalle, ce serait taper pendant qu'elle est encore à l'écran.
    await flushPromises()
    frappe('s')
    await flushPromises()
    expect(consult.tab).toBe('salles')
  })

  it('avale les raccourcis pendant qu’on lit', async () => {
    await monter()
    const consult = useConsultStore()
    consult.show('programme')
    await flushPromises()

    frappe('l')
    frappe('r')
    await flushPromises()

    /*
     * `l` et `h` basculent la projection devant du public, et une modale
     * ouverte est exactement le moment où l'on tape sans regarder.
     */
    expect(envois.filter((envoi) => envoi.url === '/control/action')).toEqual([])
  })

  it('suit une salle voisine et charge son programme à la demande', async () => {
    await monter()
    const consult = useConsultStore()

    await consult.follow('track-2')
    await flushPromises()

    // Pas dans le flux d'état : le programme d'une salle qu'on ne regarde pas
    // n'a rien à circuler à chaque changement de scène.
    expect(consult.tab).toBe('autre')
    expect(envois.some((envoi) => envoi.url === '/display/sessions?salle=track-2')).toBe(true)
  })
})

describe('une question ouverte prend le clavier', () => {
  it('répond « oui » à la fin anticipée, et rien d’autre ne passe', async () => {
    await monter()
    const conference = useConferenceStore()
    conference.endEarlyOpen = true
    await flushPromises()

    frappe('r')
    frappe('y')
    await flushPromises()

    /*
     * Un « r » réflexe pendant qu'on demande s'il faut terminer basculerait la
     * captation sous la question elle-même. La couche avale ce qu'elle n'a pas
     * lié — c'est ce que six `return` par modale faisaient dans la page
     * d'origine, et qu'il fallait penser à écrire à chaque nouvelle.
     */
    expect(envois.filter((envoi) => envoi.url === '/control/action').map((e) => e.body)).toEqual([
      { action: 'session.end' },
    ])
  })

  it('accepte « o » autant que « y »', async () => {
    await monter()
    const conference = useConferenceStore()
    conference.endEarlyOpen = true
    await flushPromises()

    frappe('o')
    await flushPromises()

    // La moitié des opérateurs tape l'un, l'autre moitié l'autre, et se tromper
    // de lettre sur cette question-là coûte un talk.
    expect(envois.at(-1)?.body).toEqual({ action: 'session.end' })
  })

  it('referme sur « n » sans rien envoyer', async () => {
    await monter()
    const conference = useConferenceStore()
    conference.endEarlyOpen = true
    await flushPromises()

    frappe('n')
    await flushPromises()

    expect(conference.endEarlyOpen).toBe(false)
    expect(envois.filter((envoi) => envoi.url === '/control/action')).toEqual([])
  })

  it('répond au clavier sur l’avertissement de captation aussi', async () => {
    /*
     * Cette question-là ne répondait à rien, quand les deux autres répondaient
     * à `y` et `n` : deux questions sur quatre au clavier, et rien à l'écran
     * pour les distinguer. Les touches sont désormais liées par `ConfirmDialog`
     * lui-même, avec le libellé qu'il imprime — donc partout, ou nulle part.
     */
    await monter()
    const conference = useConferenceStore()
    conference.recordingOpen = true
    await flushPromises()

    frappe('y')
    await flushPromises()

    expect(conference.recordingOpen).toBe(false)
    expect(envois.filter((envoi) => envoi.url === '/control/action').map((e) => e.body)).toEqual([
      { action: 'recording.start' },
      { action: 'session.start' },
      { action: 'scene.set', role: 'LIVE' },
    ])
  })

  it('laisse la troisième issue à la souris', async () => {
    // « Commencer sans enregistrer » n'est ni annuler ni confirmer : lui donner
    // une lettre en ferait une seconde façon de dire oui, à une question dont
    // la réponse par défaut coûte une VOD.
    await monter()
    const conference = useConferenceStore()
    conference.recordingOpen = true
    await flushPromises()

    for (const touche of ['r', 'l', 'm']) frappe(touche)
    await flushPromises()

    // Et la couche avale toujours ce qu'elle n'a pas lié : un « r » réflexe
    // basculerait la captation sous la question elle-même.
    expect(envois.filter((envoi) => envoi.url === '/control/action')).toEqual([])
    expect(conference.recordingOpen).toBe(true)
  })
})

describe('avant le premier octet', () => {
  it('dit qu’elle attend, plutôt que de peindre une salle vide', async () => {
    const wrapper = mount(App)
    await flushPromises()

    expect(wrapper.text()).toContain('Connexion au poste de salle')
  })
})
