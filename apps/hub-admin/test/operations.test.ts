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

const resync = vi.fn(async () => ({ ok: true, rooms: 0 }))

function stub(rooms: unknown[], pause: unknown = null): unknown {
  return {
    token: { read: () => 'jeton', write: () => {}, clear: () => {} },
    rpc: {
      rooms: { statuses: async () => rooms, resync },
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

describe('resynchronisation', () => {
  const canManage = (): void => {
    useSessionStore().permissions = new Set(['room:manage']) as never
  }

  it('is not offered to an operator the hub would refuse', async () => {
    const wrapper = await mountView()
    expect(wrapper.find('#btn-resync').exists()).toBe(false)
  })

  it('asks for confirmation, says what will go out, then requests it', async () => {
    resync.mockClear()
    canManage()
    const wrapper = await mountView()

    await wrapper.get('#btn-resync').trigger('click')
    await flushPromises()
    expect(document.querySelector('#resync-text')?.textContent).toContain('toutes les salles')
    expect(resync).not.toHaveBeenCalled()

    ;(document.querySelector('#resync-text')!
      .closest('[role="alertdialog"]')!
      .querySelectorAll('button')[1] as HTMLButtonElement).click()
    await flushPromises()
    expect(resync).toHaveBeenCalledWith({ roomId: null })
  })
})

describe('vue exploitation', () => {
  it('links each room to its speaker screen', async () => {
    const wrapper = await mountView()
    expect(wrapper.get('[data-room="track-1"] a[href="/orateur/track-1"]').text()).toContain('retour orateur')
  })

  it('carries the word beside the colour', async () => {
    const wrapper = await mountView()
    // A status dot alone cannot be read by someone who does not tell the tints
    // apart, and the card is looked at from afar.
    expect(wrapper.get('[data-room="track-1"]').text()).toContain('en cours')
  })

  it('gives the room\'s health to the dot, and the talk\'s state to the words', async () => {
    const wrapper = await mountView([{ ...ROOM, conference: 'depassement' }])

    const card = wrapper.get('[data-room="track-1"]')
    expect(card.attributes('data-health')).toBe('normal')
    expect(card.get('.status-dot').classes()).not.toContain('overrun')
    expect(card.text()).toContain('dépassement')
  })

  it('turns the card red when a capture is at risk, whatever the talk is doing', async () => {
    const obsCut = await mountView([
      { ...ROOM, obs: { A: { connected: true, missingRoles: [] }, B: { connected: false, missingRoles: [] } } },
    ])
    expect(obsCut.get('[data-room="track-1"]').attributes('data-health')).toBe('panne')
    expect(obsCut.get('[data-room="track-1"] .status-dot').classes()).toContain('offline')
    obsCut.unmount()

    // Alone on the card: no REC, no scene, nothing else to open the badge row.
    const mic = await mountView([
      { ...ROOM, audioAlerts: [{ kind: 'muet', input: 'HF 1', since: '2026-10-30T09:59:00Z' }] },
    ])
    expect(mic.get('[data-room="track-1"]').attributes('data-health')).toBe('panne')
    expect(mic.get('[data-role="problem"]').text()).toContain('HF 1')
  })

  it('marks what only needs watching, without calling it a failure', async () => {
    const wrapper = await mountView([
      { ...ROOM, streaming: true, streamHealth: { bitrateKbps: 900, skippedRatio: 0, congestion: 0.35, at: '2026-10-30T09:59:00Z' } },
    ])
    expect(wrapper.get('[data-room="track-1"]').attributes('data-health')).toBe('attention')
    expect(wrapper.get('[data-room="track-1"] .status-dot').classes()).toContain('degraded')
  })

  it('does not call a degraded link silent: that room still answers', async () => {
    const wrapper = await mountView([{ ...ROOM, connectivity: 'DEGRADED' }])

    const card = wrapper.get('[data-room="track-1"]')
    expect(card.attributes('data-health')).toBe('attention')
    expect(card.text()).not.toContain('salle muette')
    expect(card.text()).toContain('en cours')
  })

  it('says "salle muette" rather than assert a state that is unknown', async () => {
    const wrapper = await mountView([{ ...ROOM, connectivity: 'OFFLINE' }])
    const card = wrapper.get('[data-room="track-1"]')
    expect(card.get('[data-role="silent-room"]').text()).toContain('salle muette')
    expect(card.attributes('data-health')).toBe('muette')
    expect(card.get('.status-dot').classes()).toContain('silent')
  })

  it('no longer presents what a silent room last said as a fact', async () => {
    const wrapper = await mountView([
      { ...ROOM, connectivity: 'OFFLINE', recording: true, streaming: true, sceneRole: 'conference' },
    ])

    const card = wrapper.get('[data-room="track-1"]')
    expect(card.text()).not.toContain('● REC')
    expect(card.text()).not.toContain('● LIVE')
    expect(card.get('[data-role="last-contact"]').text()).toBe('Au dernier contact : REC · LIVE · conference')
    // Computed by the hub from the programme: still true of a silent room.
    expect(card.text()).toContain('10 min restantes')
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
    // The failure heads the card, ahead of what only needs watching.
    expect(card.get('[data-role="problem"]').text()).toBe('OBS-B coupé')
    expect(card.attributes('data-health')).toBe('panne')
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

  it('says a talk under way is not recorded, without calling the room broken', async () => {
    const wrapper = await mountView()
    const card = wrapper.get('[data-room="track-1"]')
    expect(card.get('[data-role="no-recording"]').text()).toBe("Pas d'enregistrement")
    expect(card.attributes('data-health')).toBe('normal')
  })

  it('does not ask for a recording outside a talk', async () => {
    const wrapper = await mountView([{ ...ROOM, conference: 'aucune' }])
    expect(wrapper.find('[data-role="no-recording"]').exists()).toBe(false)
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
