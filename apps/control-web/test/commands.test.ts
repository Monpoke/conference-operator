import type { ControlDiagnostics } from '@cloudnord/contract'
import { NO_EDITING_MARKS } from '@cloudnord/contract'
import { useToast } from '@cloudnord/components'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CapturePanel from '../src/components/CapturePanel.vue'
import MessagePanel from '../src/components/MessagePanel.vue'
import ProjectionPanel from '../src/components/ProjectionPanel.vue'
import ScreenPanel from '../src/components/ScreenPanel.vue'
import { useActionsStore } from '../src/stores/actions.js'
import { useRoomStore } from '../src/stores/room.js'
import { obsState, payload } from './fixtures.js'

/**
 * Les commandes, et la règle qui les gouverne toutes.
 *
 * Aucune n'écrit dans l'état de la salle. Le bouton actif décrit **où la salle
 * en est**, jamais ce qu'on vient de demander — la différence est invisible
 * tant que tout marche, et c'est exactement le jour où la bascule échoue
 * qu'elle compte.
 */

interface Envoi {
  url: string
  body: unknown
}

function stubFetch(reponse: unknown = { ok: true }): Envoi[] {
  const envois: Envoi[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    envois.push({ url, body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify(reponse), {
      headers: { 'content-type': 'application/json' },
    })
  })
  return envois
}

beforeEach(() => {
  setActivePinia(createPinia())
  useToast().clear()
  vi.unstubAllGlobals()
})

describe('poster une action', () => {
  it('n’écrit rien dans l’état de la salle', async () => {
    const envois = stubFetch()
    const room = useRoomStore()
    room.seed(payload())
    const avant = room.payload?.state.sceneRole

    await useActionsStore().act({ action: 'scene.set', role: 'LIVE' })

    /*
     * Peindre d'avance donnerait un bouton actif décrivant ce qu'on a demandé
     * et non ce qui est. C'est le delta du flux qui repeindra, une fois qu'OBS
     * aura vraiment basculé.
     */
    expect(envois).toEqual([
      { url: '/control/action', body: { action: 'scene.set', role: 'LIVE' } },
    ])
    expect(room.payload?.state.sceneRole).toBe(avant)
  })

  it('reprend le refus du poste, mot pour mot', async () => {
    stubFetch({ ok: false, message: 'OBS-A ne répond pas' })

    await useActionsStore().act({ action: 'scene.set', role: 'LIVE' })

    // Le message est écrit pour l'opérateur, par la couche qui sait pourquoi
    // c'est refusé. Le traduire ici lui ferait perdre sa seule prise.
    expect(useToast().notices.value.at(-1)).toMatchObject({
      text: 'OBS-A ne répond pas',
      failed: true,
    })
  })

  it('nomme la panne locale, qui n’est pas une panne du hub', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('injoignable')
    })

    const resultat = await useActionsStore().act({ action: 'recording.start' })

    // Un échec ici ne veut pas dire « le hub est loin » : le cœur applicatif de
    // la salle ne répond plus, et c'est la panne qui arrête tout.
    expect(resultat).toEqual({ ok: false, message: 'Le service local ne répond pas' })
    expect(useToast().notices.value.at(-1)?.failed).toBe(true)
  })
})

describe('écran de salle', () => {
  it('marque le mode en vigueur, pas celui qu’on vient de cliquer', async () => {
    const envois = stubFetch()
    const wrapper = mount(ScreenPanel, { props: { mode: 'loop' } })

    await wrapper.get('[data-command="sponsors"]').trigger('click')
    await flushPromises()

    expect(envois[0]?.body).toEqual({ action: 'display.set', mode: 'sponsors' })
    // La boucle reste marquée : le flux n'a rien dit d'autre.
    expect(wrapper.get('[data-command="loop"]').classes()).toContain('bg-brand')
    expect(wrapper.get('[data-command="sponsors"]').classes()).not.toContain('bg-brand')
  })
})

describe('projection', () => {
  it('ne propose le relais que là où il est configuré', () => {
    const sans = mount(ProjectionPanel, {
      props: { sceneRole: 'HOLD', relaySourceRoomId: null, obs: null },
    })
    expect(sans.find('[data-command="RELAY"]').exists()).toBe(false)

    const avec = mount(ProjectionPanel, {
      props: { sceneRole: 'HOLD', relaySourceRoomId: 'track-2', obs: null },
    })

    // « Relais → track-2 » plutôt qu'un bouton dont personne ne sait ce qu'il
    // montre.
    expect(avec.get('[data-command="RELAY"]').text()).toContain('Relais → track-2')
  })

  it('rappelle qu’une instance simulée ne capte rien', () => {
    const wrapper = mount(ProjectionPanel, {
      props: {
        sceneRole: 'LIVE',
        relaySourceRoomId: null,
        obs: obsState({ simulated: true }),
      },
    })

    // Rien ne distingue à l'écran un pilotage simulé d'un vrai, sauf qu'aucune
    // caméra n'est branchée derrière.
    expect(wrapper.text()).toContain('simulé')
  })
})

describe('message à la console', () => {
  it('n’envoie pas de message vide, ni d’espaces', async () => {
    const envois = stubFetch()
    const wrapper = mount(MessagePanel)

    await wrapper.get('#message-text').setValue('   ')
    await wrapper.get('#btn-message').trigger('click')
    await flushPromises()

    expect(envois).toEqual([])
  })

  it('part avec son niveau, et vide le champ', async () => {
    const envois = stubFetch()
    const wrapper = mount(MessagePanel)

    await wrapper.get('#message-text').setValue('Le micro coupe')
    await wrapper.get('#message-level').setValue('urgent')
    await wrapper.get('#message-text').trigger('keydown.enter')
    await flushPromises()

    expect(envois[0]?.body).toEqual({
      action: 'message.send',
      text: 'Le micro coupe',
      level: 'urgent',
    })
    expect((wrapper.get('#message-text').element as HTMLInputElement).value).toBe('')
  })
})

describe('captation', () => {
  const REC = { active: true, markers: 2, startedAtMs: 1_000, startedAtCorrectedMs: null, editing: NO_EDITING_MARKS }

  function monter(
    recording: ControlDiagnostics['recording'] | null,
    streaming = false,
  ): ReturnType<typeof mount> {
    return mount(CapturePanel, {
      props: { recording, streaming, obs: null, realMs: 61_000, roomMs: 61_000 },
    })
  }

  it('propose d’arrêter ce qui tourne, et de lancer ce qui ne tourne pas', () => {
    expect(monter(REC).get('#btn-rec').text()).toContain('Arrêter')
    expect(monter(null).get('#btn-rec').text()).toContain('Enregistrer')
  })

  it('poste l’arrêt quand ça tourne, le départ sinon', async () => {
    const envois = stubFetch()

    await monter(REC).get('#btn-rec').trigger('click')
    await monter(null).get('#btn-rec').trigger('click')
    await flushPromises()

    expect(envois.map((envoi) => envoi.body)).toEqual([
      { action: 'recording.stop' },
      { action: 'recording.start' },
    ])
  })

  it('ne laisse pas poser un marqueur hors enregistrement', () => {
    const wrapper = monter(null)

    // Un marqueur sans prise ne se rattache à rien : le poste le refuserait, et
    // un bouton actif dont la commande est refusée est un piège.
    expect(wrapper.get('#btn-brandur').attributes('disabled')).toBeDefined()
    expect(wrapper.get('#label-brandur').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-role="markers"]').text()).toBe('hors enregistrement')
  })

  it('marque sans libellé plutôt que de ne pas marquer', async () => {
    const envois = stubFetch()
    const wrapper = monter(REC)

    await wrapper.get('#btn-brandur').trigger('click')
    await flushPromises()

    // Au editing, savoir *où* vaut déjà mieux que rien, et exiger un mot ferait
    // rater l'instant.
    expect(envois[0]?.body).toEqual({ action: 'recording.mark', label: 'Chapitre' })
  })

  it('reprend le libellé saisi, et vide le champ', async () => {
    const envois = stubFetch()
    const wrapper = monter(REC)

    await wrapper.get('#label-brandur').setValue('Questions')
    await wrapper.get('#btn-brandur').trigger('click')
    await flushPromises()

    expect(envois[0]?.body).toEqual({ action: 'recording.mark', label: 'Questions' })
    expect((wrapper.get('#label-brandur').element as HTMLInputElement).value).toBe('')
  })

  /*
   * Les deux repères de editing, vus du panneau.
   *
   * Ce qui compte ici : le rôle part avec le geste, et le libellé n'est pas
   * saisi. Le poste ne lit que `role` ; le libellé, lui, se relit dans le
   * journal du hub et doit dire la même chose d'une salle à l'autre.
   */
  it('poste les deux repères avec leur rôle, sans passer par le champ', async () => {
    const envois = stubFetch()
    const wrapper = monter(REC)

    await wrapper.get('#btn-repere-debut').trigger('click')
    await wrapper.get('#btn-repere-fin').trigger('click')
    await flushPromises()

    expect(envois.map((envoi) => envoi.body)).toEqual([
      { action: 'recording.mark', label: 'Début', role: 'debut' },
      { action: 'recording.mark', label: 'Fin', role: 'fin' },
    ])
  })

  it('montre où le repère est tombé, pas seulement qu’il est posé', () => {
    const wrapper = monter({ ...REC, editing: { startMs: 52_000, endMs: null } })

    // « Posé » et « posé où » sont deux questions, et la seconde est celle
    // qu'on se pose quand on hésite à reposer le repère.
    expect(wrapper.get('#btn-repere-debut').text()).toContain('Début · 00:52')
    expect(wrapper.get('#btn-repere-fin').text()).not.toContain('·')
  })

  it('ne laisse pas poser de repère hors enregistrement', () => {
    const wrapper = monter(null)

    expect(wrapper.get('#btn-repere-debut').attributes('disabled')).toBeDefined()
    expect(wrapper.get('#btn-repere-fin').attributes('disabled')).toBeDefined()
  })

  it('compte les marqueurs posés', () => {
    expect(monter(REC).get('[data-role="markers"]').text()).toBe('2 marqueur(s)')
    expect(monter({ ...REC, markers: 0 }).get('[data-role="markers"]').text()).toBe(
      'aucun marqueur',
    )
  })

  it('bascule la diffusion dans le sens où elle n’est pas', async () => {
    const envois = stubFetch()

    await monter(null, true).get('#btn-stream').trigger('click')
    await monter(null, false).get('#btn-stream').trigger('click')
    await flushPromises()

    expect(envois.map((envoi) => envoi.body)).toEqual([
      { action: 'stream.stop' },
      { action: 'stream.start' },
    ])
  })
})
