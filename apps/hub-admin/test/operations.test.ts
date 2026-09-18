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

const ROOM = {
  roomId: 'track-1',
  name: 'Track #1',
  conference: 'en-cours',
  connectivity: 'ONLINE',
  recording: false,
  streaming: false,
  audioInputs: [],
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

async function mountView(rooms: unknown[] = [ROOM], pause: unknown = null): Promise<ReturnType<typeof mount>> {
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
    const wrapper = await mountView([{ ...ROOM, conference: 'depassement', connectivity: 'DEGRADED' }])

    // A dot carrying only the connectivity showed a green room while it was
    // overrunning by ten minutes.
    const dot = wrapper.get('[data-room="track-1"] .status-dot')
    expect(dot.classes()).toContain('overrun')
    expect(dot.classes()).toContain('unsure')
  })

  it('says "salle muette" rather than assert a state that is unknown', async () => {
    const wrapper = await mountView([{ ...ROOM, connectivity: 'OFFLINE' }])
    expect(wrapper.get('[data-room="track-1"]').text()).toContain('salle muette')
  })

  it('does not present a shared slot as a talk', async () => {
    const wrapper = await mountView([{ ...ROOM, breakBadge: { state: 'en-cours' } }])

    // "Déjeuner · 22 min restantes" read as a busy room where there is nobody. A
    // tag, and the line below stays silent.
    const card = wrapper.get('[data-room="track-1"]')
    expect(card.text()).toContain('BREAK')
    expect(card.text()).not.toContain('restantes')
  })

  it('says which OBS is cut, and which scene cannot be found', async () => {
    /*
     * Reported by the room all along, and read by nobody: a room whose OBS-A had
     * no "LIVE" scene logged it on its own machine, and the console never knew.
     */
    const wrapper = await mountView([
      {
        ...ROOM,
        obs: {
          A: { connected: true, missingRoles: ['LIVE'] },
          B: { connected: false, missingRoles: [] },
        },
      },
    ])

    const card = wrapper.get('[data-room="track-1"]')
    expect(card.text()).toContain('scène LIVE introuvable')
    expect(card.text()).toContain('OBS-B coupé')
    expect(card.html()).toContain('text-alert')
  })

  it('says nothing about the OBS of a room that no longer answers', async () => {
    // What a silent room last said is exactly what can no longer be trusted.
    const wrapper = await mountView([
      { ...ROOM, connectivity: 'OFFLINE', obs: { A: { connected: false, missingRoles: [] }, B: { connected: true, missingRoles: [] } } },
    ])
    expect(wrapper.get('[data-room="track-1"]').text()).not.toContain('OBS-A coupé')
  })

  it('shows the stream bitrate, and why it worries when it does', async () => {
    const healthy = await mountView([
      { ...ROOM, streaming: true, streamHealth: { bitrateKbps: 4500, skippedRatio: 0, congestion: 0.02, at: '2026-10-30T09:59:00Z' } },
    ])
    expect(healthy.get('[data-room="track-1"]').text()).toContain('4,5 Mb/s')
    expect(healthy.get('[data-room="track-1"]').text()).not.toContain('congestion')
    healthy.unmount()

    const suffering = await mountView([
      { ...ROOM, streaming: true, streamHealth: { bitrateKbps: 900, skippedRatio: 0.04, congestion: 0.35, at: '2026-10-30T09:59:00Z' } },
    ])
    const text = suffering.get('[data-room="track-1"]').text()
    expect(text).toContain('900 kb/s')
    expect(text).toContain('congestion 35 %')
    expect(text).toContain("4 % d'images perdues")
  })

  it('shows what matters for a decision: REC, LIVE, and the queue', async () => {
    const wrapper = await mountView([
      { ...ROOM, recording: true, streaming: true, outboxDepth: 3, sceneRole: 'LIVE' },
    ])

    const card = wrapper.get('[data-room="track-1"]')
    expect(card.text()).toContain('● REC')
    expect(card.text()).toContain('● LIVE')
    expect(card.text()).toContain('3 en file')
  })

  it('shows the Global panel only when a shared slot exists', async () => {
    expect((await mountView()).find('#global-panel').exists()).toBe(false)

    const wrapper = await mountView([ROOM], {
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
    const wrapper = await mountView([ROOM], {
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
