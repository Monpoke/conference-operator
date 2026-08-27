import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import OperationsView from '../src/views/OperationsView.vue'
import { slotRemaining, useOperationsStore } from '../src/stores/operations.js'
import { useSessionStore } from '../src/stores/session.js'

/**
 * Le tableau de bord.
 *
 * La vue laissée ouverte toute la journée, et regardée de loin. Ce qu'elle doit
 * dire sans qu'on lise : où en est chaque salle, si on peut lui faire confiance,
 * et si quelque chose demande un geste maintenant.
 */

const SALLE = {
  roomId: 'track-1',
  name: 'Track #1',
  conference: 'en-cours',
  connectivity: 'ONLINE',
  recording: false,
  streaming: false,
  sceneRole: null,
  outboxDepth: 0,
  lastSeenAt: '2026-10-30T09:59:00Z',
  currentSession: { title: 'Vue et les régies', remainingMs: 600_000 },
  breakBadge: null,
}

function stub(rooms: unknown[], pause: unknown = null): unknown {
  return {
    token: { read: () => 'jeton', write: () => {}, clear: () => {} },
    rpc: {
      rooms: { statuses: async () => rooms },
      program: { globalBreak: async () => pause },
    },
  }
}

async function monter(rooms: unknown[] = [SALLE], pause: unknown = null): Promise<ReturnType<typeof mount>> {
  useSessionStore().client = stub(rooms, pause) as never
  const wrapper = mount(OperationsView, { attachTo: document.body, global: { stubs: { RouterLink: true } } })
  await useOperationsStore().load()
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  document.body.innerHTML = ''
  setActivePinia(createPinia())
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
})

describe('temps restant sur le créneau', () => {
  it('arrondit à la minute : la seconde serait fausse aussitôt affichée', () => {
    expect(slotRemaining(600_000)).toEqual({ texte: '10 min restantes', depasse: false })
  })

  it('distingue le dépassement, qui est la raison d’être de l’affichage', () => {
    expect(slotRemaining(-180_000)).toEqual({ texte: 'dépassement de 3 min', depasse: true })
  })

  it('ne dit rien quand le hub ne sait pas', () => {
    expect(slotRemaining(null)).toBe(null)
  })
})

describe('vue exploitation', () => {
  it('porte le mot à côté de la couleur', async () => {
    const wrapper = await monter()
    // Une pastille seule ne se lit pas quand on ne distingue pas les teintes,
    // et la carte se regarde de loin.
    expect(wrapper.get('[data-salle="track-1"]').text()).toContain('en cours')
  })

  it('sépare le remplissage de la conférence du contour de la salle', async () => {
    const wrapper = await monter([{ ...SALLE, conference: 'depassement', connectivity: 'DEGRADED' }])

    // Une pastille qui ne portait que la connectivité affichait une salle verte
    // alors qu'elle débordait de dix minutes.
    const pastille = wrapper.get('[data-salle="track-1"] .pastille')
    expect(pastille.classes()).toContain('depassement')
    expect(pastille.classes()).toContain('doute')
  })

  it('dit « salle muette » plutôt que d’affirmer un état qu’on ignore', async () => {
    const wrapper = await monter([{ ...SALLE, connectivity: 'OFFLINE' }])
    expect(wrapper.get('[data-salle="track-1"]').text()).toContain('salle muette')
  })

  it('ne présente pas un créneau commun comme une conférence', async () => {
    const wrapper = await monter([{ ...SALLE, breakBadge: { state: 'en-cours' } }])

    // « Déjeuner · 22 min restantes » se lisait comme une salle occupée là où il
    // n'y a personne. Une étiquette, et la ligne du dessous se tait.
    const carte = wrapper.get('[data-salle="track-1"]')
    expect(carte.text()).toContain('BREAK')
    expect(carte.text()).not.toContain('restantes')
  })

  it('montre ce qui compte pour décider : REC, LIVE, et la file', async () => {
    const wrapper = await monter([
      { ...SALLE, recording: true, streaming: true, outboxDepth: 3, sceneRole: 'LIVE' },
    ])

    const carte = wrapper.get('[data-salle="track-1"]')
    expect(carte.text()).toContain('● REC')
    expect(carte.text()).toContain('● LIVE')
    expect(carte.text()).toContain('3 en file')
  })

  it('n’affiche l’encart Global que lorsqu’un créneau commun existe', async () => {
    expect((await monter()).find('#encart-global').exists()).toBe(false)

    const wrapper = await monter([SALLE], {
      title: 'Déjeuner',
      state: 'en-cours',
      startsAt: '2026-10-30T11:00:00Z',
      endsAt: '2026-10-30T12:00:00Z',
      rooms: 3,
      serverTime: '2026-10-30T11:38:00Z',
    })

    // Ce qu'on vient y chercher : quand ça reprend.
    expect(wrapper.get('#global-detail').text()).toContain('reprise dans 22 min')
    expect(wrapper.get('#global-detail').text()).toContain('3 salles')
  })

  it('annonce un créneau commun à venir sans dire qu’il a commencé', async () => {
    const wrapper = await monter([SALLE], {
      title: 'Déjeuner',
      state: 'a-venir',
      startsAt: '2026-10-30T11:00:00Z',
      endsAt: null,
      rooms: 1,
      serverTime: '2026-10-30T10:50:00Z',
    })

    expect(wrapper.get('#global-titre').text()).toContain('à venir')
    expect(wrapper.get('#global-detail').text()).toContain('dans 10 min')
    expect(wrapper.get('#global-detail').text()).toContain('1 salle')
  })

  it('dit qu’aucune salle n’est déclarée plutôt que de laisser une grille vide', async () => {
    expect((await monter([])).get('#salles').text()).toContain('Aucune salle déclarée')
  })
})
