import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App.vue'
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

async function monter(recording: unknown = null): Promise<ReturnType<typeof mount>> {
  const etat = payload()
  etat.diagnostics!.recording = recording as never
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
    await monter({ active: true, markers: 0, startedAtMs: 0, startedAtCorrigeMs: null })

    frappe('r')
    await flushPromises()

    expect(envois.at(-1)?.body).toEqual({ action: 'recording.stop' })
  })

  it('pose un marqueur pendant une prise', async () => {
    await monter({ active: true, markers: 0, startedAtMs: 0, startedAtCorrigeMs: null })

    frappe('m')
    await flushPromises()

    expect(envois.at(-1)?.body).toEqual({ action: 'recording.mark', label: 'Chapitre' })
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
    const champ = wrapper.get('#message-texte')

    await champ.setValue('l')
    champ.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }))
    await flushPromises()

    // Écrire « le micro coupe » dans le message à la console ne doit pas
    // basculer la projection en direct au premier caractère.
    expect(envois.filter((envoi) => envoi.url === '/control/action')).toEqual([])
  })
})

describe('avant le premier octet', () => {
  it('dit qu’elle attend, plutôt que de peindre une salle vide', async () => {
    const wrapper = mount(App)
    await flushPromises()

    expect(wrapper.text()).toContain('Connexion au poste de salle')
  })
})
