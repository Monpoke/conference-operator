import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import OperationsView from '../src/views/OperationsView.vue'
import { slotRemaining, useOperationsStore } from '../src/stores/operations.js'
import { useSessionStore } from '../src/stores/session.js'

/**
 * The dashboard.
 *
 * The view left open all day, and looked at from afar. What it must say without
 * being read: where each room stands, whether it can be trusted, and whether
 * anything calls for a gesture now.
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

async function mountView(rooms: unknown[] = [SALLE], pause: unknown = null): Promise<ReturnType<typeof mount>> {
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

describe('time left in the slot', () => {
  it('rounds to the minute: the second would be wrong the instant it was shown', () => {
    expect(slotRemaining(600_000)).toEqual({ text: '10 min restantes', overrun: false })
  })

  it('sets the overrun apart, which is this display\'s reason for being', () => {
    expect(slotRemaining(-180_000)).toEqual({ text: 'dépassement de 3 min', overrun: true })
  })

  it('says nothing when the hub does not know', () => {
    expect(slotRemaining(null)).toBe(null)
  })
})

describe('vue exploitation', () => {
  it('carries the word beside the colour', async () => {
    const wrapper = await mountView()
    // A status dot alone cannot be read by someone who does not tell the tints
    // apart, and the card is looked at from afar.
    expect(wrapper.get('[data-room="track-1"]').text()).toContain('en cours')
  })

  it('separates the talk\'s fill from the room\'s outline', async () => {
    const wrapper = await mountView([{ ...SALLE, conference: 'depassement', connectivity: 'DEGRADED' }])

    // A dot carrying only the connectivity showed a green room while it was
    // overrunning by ten minutes.
    const pastille = wrapper.get('[data-room="track-1"] .status-dot')
    expect(pastille.classes()).toContain('overrun')
    expect(pastille.classes()).toContain('unsure')
  })

  it('says "salle muette" rather than assert a state that is unknown', async () => {
    const wrapper = await mountView([{ ...SALLE, connectivity: 'OFFLINE' }])
    expect(wrapper.get('[data-room="track-1"]').text()).toContain('salle muette')
  })

  it('does not present a shared slot as a talk', async () => {
    const wrapper = await mountView([{ ...SALLE, breakBadge: { state: 'en-cours' } }])

    // "Déjeuner · 22 min restantes" read as a busy room where there is nobody. A
    // tag, and the line below stays silent.
    const carte = wrapper.get('[data-room="track-1"]')
    expect(carte.text()).toContain('BREAK')
    expect(carte.text()).not.toContain('restantes')
  })

  it('shows what matters for a decision: REC, LIVE, and the queue', async () => {
    const wrapper = await mountView([
      { ...SALLE, recording: true, streaming: true, outboxDepth: 3, sceneRole: 'LIVE' },
    ])

    const carte = wrapper.get('[data-room="track-1"]')
    expect(carte.text()).toContain('● REC')
    expect(carte.text()).toContain('● LIVE')
    expect(carte.text()).toContain('3 en file')
  })

  it('shows the Global panel only when a shared slot exists', async () => {
    expect((await mountView()).find('#global-panel').exists()).toBe(false)

    const wrapper = await mountView([SALLE], {
      title: 'Déjeuner',
      state: 'en-cours',
      startsAt: '2026-10-30T11:00:00Z',
      endsAt: '2026-10-30T12:00:00Z',
      rooms: 3,
      serverTime: '2026-10-30T11:38:00Z',
    })

    // What one comes to it for: when it resumes.
    expect(wrapper.get('#global-detail').text()).toContain('reprise dans 22 min')
    expect(wrapper.get('#global-detail').text()).toContain('3 salles')
  })

  it('announces an upcoming shared slot without saying it has begun', async () => {
    const wrapper = await mountView([SALLE], {
      title: 'Déjeuner',
      state: 'a-venir',
      startsAt: '2026-10-30T11:00:00Z',
      endsAt: null,
      rooms: 1,
      serverTime: '2026-10-30T10:50:00Z',
    })

    expect(wrapper.get('#global-title').text()).toContain('à venir')
    expect(wrapper.get('#global-detail').text()).toContain('dans 10 min')
    expect(wrapper.get('#global-detail').text()).toContain('1 salle')
  })

  it('says no room is declared rather than leave an empty grid', async () => {
    expect((await mountView([])).get('#rooms').text()).toContain('Aucune salle déclarée')
  })
})
