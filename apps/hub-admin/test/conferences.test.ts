import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ConferencesView from '../src/views/ConferencesView.vue'
import {
  canPin,
  overrideChoice,
  partnersByRoom,
  placeInDay,
  swapBlocked,
  swapPartners,
  useConferencesStore,
  type PlannedSession,
} from '../src/stores/conferences.js'
import { useSessionStore } from '../src/stores/session.js'

/**
 * Talks and schedule.
 *
 * The console's densest view, and the one where the structural decisions are least
 * visible: the time read in the event's time zone and not the machine's, the "en ce
 * moment" marker set against the hub's clock which may be simulated, the action
 * column collapsed because it writes where six columns read, and the menu that
 * offers only the action contradicting the export.
 *
 * None of those four is visible on reading. They are what is held here.
 */

interface Call {
  path: string
  input: unknown
}

const PARIS = 'Europe/Paris'

const TALK: PlannedSession = {
  id: 'talk-1',
  roomId: 'track-1',
  roomName: 'Track #1',
  title: 'Vue et les régies',
  kind: 'talk',
  speakers: ['Camille'],
  startsAt: '2026-10-30T09:00:00Z',
  endsAt: '2026-10-30T09:45:00Z',
  startedAt: null,
  endedAt: null,
  feedbackUrl: 'https://openfeedback.io/cloudnord/2026/talk-1',
  feedbackIdOverride: null,
  overriddenAs: null,
  sharedFrom: null,
}

const PAUSE: PlannedSession = {
  ...TALK,
  id: 'pause-1',
  title: 'Déjeuner',
  kind: 'break',
  speakers: [],
  startsAt: '2026-10-30T11:00:00Z',
  endsAt: '2026-10-30T12:00:00Z',
  feedbackUrl: null,
}

const INHERITED: PlannedSession = { ...PAUSE, id: 'pause-2', sharedFrom: 'track-1' }

function stub(options: {
  states?: unknown[]
  sessions?: PlannedSession[]
  serverTime?: string
  projectId?: string | null
  overrideError?: string
  pins?: Record<string, string>
}): { calls: Call[]; client: unknown } {
  const calls: Call[] = []
  const note =
    (path: string, result: unknown, error?: string) =>
    async (input: unknown = undefined) => {
      calls.push({ path, input })
      if (error != null) throw new Error(error)
      return result
    }
  return {
    calls,
    client: {
      token: { read: () => 'jeton', write: () => {}, clear: () => {} },
      rpc: {
        sessions: {
          states: note('sessions/states', options.states ?? []),
          start: note('sessions/start', { ok: true }),
          end: note('sessions/end', { ok: true }),
          reset: note('sessions/reset', { ok: true }),
          override: note('sessions/override', { ok: true }, options.overrideError),
          swap: note('sessions/swap', { ok: true, contentHash: 'h' }),
          resetSlots: note('sessions/resetSlots', { ok: true, contentHash: 'h' }),
          pin: note('sessions/pin', { ok: true, pins: {} }),
          feedbackId: note('sessions/feedbackId', { ok: true }),
        },
        program: {
          snapshots: note('program/snapshots', [{ active: true }]),
          images: note('program/images', { held: 0, failed: [] }),
          planning: note('program/planning', {
            sessions: options.sessions ?? [TALK],
            rooms: [{ id: 'track-1', name: 'Track #1' }],
            timezone: PARIS,
            serverTime: options.serverTime ?? '2026-10-30T08:00:00Z',
            openFeedbackProjectId: options.projectId === undefined ? 'cloudnord' : options.projectId,
            pins: options.pins ?? {},
          }),
          controleOpenFeedback: note('program/controleOpenFeedback', {
            projet: 'cloudnord',
            projetTrouve: true,
            detail: 'Relevé à 09:00.',
            talksConnus: 27,
            manquants: [],
          }),
        },
        vod: { conference: note('vod/conference', {}), request: note('vod/request', { ok: true }) },
      },
    },
  }
}

async function mountView(options: Parameters<typeof stub>[0] = {}): Promise<{
  calls: Call[]
  wrapper: ReturnType<typeof mount>
}> {
  const fake = stub(options)
  useSessionStore().client = fake.client as never
  const wrapper = mount(ConferencesView, { attachTo: document.body })
  await useConferencesStore().load()
  await flushPromises()
  return { calls: fake.calls, wrapper }
}

beforeEach(() => {
  document.body.innerHTML = ''
  setActivePinia(createPinia())
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
})

describe('place in the day', () => {
  const noon = Date.parse('2026-10-30T09:20:00Z')

  it('holds a slot with no end as running, not as past', () => {
    // It runs until proven otherwise, rather than be declared past the second it
    // begins.
    expect(placeInDay({ ...TALK, endsAt: null }, noon)).toBe('en-cours')
  })

  it.each([
    ['a-venir', '2026-10-30T10:00:00Z', '2026-10-30T10:45:00Z'],
    ['en-cours', '2026-10-30T09:00:00Z', '2026-10-30T09:45:00Z'],
    ['passe', '2026-10-30T08:00:00Z', '2026-10-30T08:45:00Z'],
  ])('situe %s', (attendu, startsAt, endsAt) => {
    expect(placeInDay({ ...TALK, startsAt, endsAt }, noon)).toBe(attendu)
  })
})

describe('decision menu', () => {
  it("n'offre que l'action qui contredit l'export", () => {
    // The other would do nothing: offering "treat as a talk" on a talk is a choice
    // with no effect, in the middle of a table one is scanning.
    expect(overrideChoice(TALK)).toEqual({ scheduled: 'talk', action: 'break' })
    expect(overrideChoice(PAUSE)).toEqual({ scheduled: 'break', action: 'talk' })
  })

  it('offers to go back on a decision already made', () => {
    expect(overrideChoice({ ...TALK, overriddenAs: 'break' })).toEqual({
      scheduled: 'talk',
      action: 'break',
    })
  })
})

/** Another talk of the same day, in the other room. */
const OTHER: PlannedSession = {
  ...TALK,
  id: 'talk-2',
  roomId: 'track-2',
  roomName: 'Track #2',
  title: 'Pinia sans détour',
  startsAt: '2026-10-30T10:00:00Z',
  endsAt: '2026-10-30T10:45:00Z',
}

describe('swap partners', () => {
  it('says why a slot cannot be swapped, before the hub refuses it', () => {
    expect(swapBlocked(TALK)).toBeNull()
    expect(swapBlocked(PAUSE)).toBe("Seule une conférence s'échange")
    expect(swapBlocked({ ...TALK, sharedFrom: 'track-2' })).toBe("Pause héritée d'une autre salle")
    // Its lifecycle was written for the room and the hour it had.
    expect(swapBlocked({ ...TALK, startedAt: '2026-10-30T09:01:00Z' })).toBe(
      'Conférence déjà commencée',
    )
    expect(
      swapBlocked({ ...TALK, startedAt: '2026-10-30T09:01:00Z', endedAt: '2026-10-30T09:40:00Z' }),
    ).toBe('Conférence déjà terminée')
  })

  it('offers the other talks of the same day not yet started, and never itself', () => {
    const tomorrow = { ...OTHER, id: 'talk-3', startsAt: '2026-10-31T09:00:00Z' }
    const started = { ...OTHER, id: 'talk-4', startedAt: '2026-10-30T10:00:00Z' }
    const partners = swapPartners(TALK, [TALK, OTHER, PAUSE, tomorrow, started], PARIS)
    expect(partners.map((s) => s.id)).toEqual(['talk-2'])
  })

  it("reads the day in the event's zone, not in UTC", () => {
    // 23:30 UTC on the 29th is already the 30th in Paris.
    const late = { ...OTHER, id: 'talk-5', startsAt: '2026-10-29T23:30:00Z' }
    expect(swapPartners(TALK, [late], PARIS).map((s) => s.id)).toEqual(['talk-5'])
  })

  it('offers nothing to a slot that cannot be swapped', () => {
    expect(swapPartners(PAUSE, [TALK, OTHER], PARIS)).toEqual([])
  })

  it('groups the partners by room', () => {
    const groups = partnersByRoom([OTHER, TALK, { ...OTHER, id: 'talk-6' }])
    expect(groups.map((g) => [g.room, g.sessions.length])).toEqual([
      ['Track #2', 2],
      ['Track #1', 1],
    ])
  })

  it('forces only a talk of a room, not over yet', () => {
    expect(canPin(TALK)).toBe(true)
    expect(canPin({ ...TALK, startedAt: '2026-10-30T09:01:00Z' })).toBe(true)
    expect(canPin({ ...TALK, endedAt: '2026-10-30T09:40:00Z' })).toBe(false)
    expect(canPin({ ...TALK, roomId: null })).toBe(false)
    expect(canPin(PAUSE)).toBe(false)
  })
})

describe('emergency gestures', () => {
  it('swaps two talks and reads the program back from the hub', async () => {
    const { calls, wrapper } = await mountView({ sessions: [TALK, OTHER] })
    await wrapper.get('#btn-planning-actions').trigger('click')

    await wrapper.get('[data-swap-session="talk-1"]').setValue('talk-2')
    await flushPromises()

    expect(calls).toContainEqual({ path: 'sessions/swap', input: { a: 'talk-1', b: 'talk-2' } })
    expect(calls.filter((call) => call.path === 'program/planning')).toHaveLength(2)
    // A trigger, not a state: the menu goes back to its prompt.
    const menu = wrapper.get('[data-swap-session="talk-1"]').element as HTMLSelectElement
    expect(menu.value).toBe('')
  })

  it('greys out the menu on a talk already started, and says why', async () => {
    const { wrapper } = await mountView({
      sessions: [{ ...TALK, startedAt: '2026-10-30T09:01:00Z' }, OTHER],
    })
    await wrapper.get('#btn-planning-actions').trigger('click')

    const menu = wrapper.get('[data-swap-session="talk-1"]')
    expect(menu.attributes('disabled')).toBeDefined()
    expect(menu.attributes('title')).toBe('Conférence déjà commencée')
  })

  it('shows a moved talk, and whose slot it took, even with the actions collapsed', async () => {
    const { wrapper } = await mountView({ sessions: [{ ...TALK, movedTo: 'talk-2' }, OTHER] })

    expect(wrapper.get('[data-moved="talk-1"]').attributes('title')).toBe(
      'Occupe le créneau de Pinia sans détour',
    )
    expect(wrapper.get('#planning-moved').text()).toContain('1 conférence déplacée')
  })

  it('gives the slots back to the program only once confirmed', async () => {
    const { calls, wrapper } = await mountView({ sessions: [{ ...TALK, movedTo: 'talk-2' }, OTHER] })
    await wrapper.get('#btn-planning-actions').trigger('click')

    await wrapper.get('#btn-reset-slots').trigger('click')
    await flushPromises()
    expect(calls.filter((call) => call.path === 'sessions/resetSlots')).toHaveLength(0)

    const confirm = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.includes('Rendre les créneaux') && button.id === '',
    )
    confirm!.click()
    await flushPromises()
    expect(calls.filter((call) => call.path === 'sessions/resetSlots')).toHaveLength(1)
  })

  it('forces a talk in its room, and lifts it', async () => {
    const { calls, wrapper } = await mountView({ sessions: [TALK, OTHER] })
    await wrapper.get('#btn-planning-actions').trigger('click')

    await wrapper.get('[data-pin-session="talk-2"]').trigger('click')
    await flushPromises()
    expect(calls).toContainEqual({
      path: 'sessions/pin',
      input: { roomId: 'track-2', sessionId: 'talk-2' },
    })
  })

  it('marks the forced talk and offers to lift it', async () => {
    const { calls, wrapper } = await mountView({
      sessions: [TALK, OTHER],
      pins: { 'track-2': 'talk-2' },
    })
    await wrapper.get('#btn-planning-actions').trigger('click')

    expect(wrapper.get('[data-pinned="talk-2"]').text()).toContain('Forcée')
    expect(wrapper.find('[data-pin-session="talk-2"]').exists()).toBe(false)

    await wrapper.get('[data-unpin-session="talk-2"]').trigger('click')
    await flushPromises()
    expect(calls).toContainEqual({
      path: 'sessions/pin',
      input: { roomId: 'track-2', sessionId: null },
    })
  })
})

describe('conferences view', () => {
  it("reads the times in the event's time zone, not the machine's", async () => {
    const { wrapper } = await mountView()

    // 09:00 UTC = 10:00 in Paris. The console opens from anywhere and the program
    // does not shift.
    expect(wrapper.get('[data-slot="talk-1"]').text()).toContain('10:00')
  })

  it('sets "en ce moment" against the hub\'s clock, which may be simulated', async () => {
    const { wrapper } = await mountView({ serverTime: '2026-10-30T09:20:00Z' })

    const row = wrapper.get('[data-slot="talk-1"]')
    expect(row.attributes('data-when')).toBe('en-cours')
    expect(row.text()).toContain('en ce moment')
  })

  it('collapses the action column, and says how many decisions are in force', async () => {
    const { wrapper } = await mountView({
      sessions: [TALK, { ...PAUSE, overriddenAs: 'talk' }],
    })

    // It is the only column that writes, among six that read, and its decision
    // propagates all the way to the projected QR codes.
    expect(wrapper.find('[data-session-action]').exists()).toBe(false)
    expect(wrapper.get('#btn-planning-actions').text()).toContain('1 décision')

    await wrapper.get('#btn-planning-actions').trigger('click')
    expect(wrapper.find('[data-session-action]').exists()).toBe(true)
  })

  it('does not offer to decide a break inherited from another room', async () => {
    const { wrapper } = await mountView({ sessions: [INHERITED] })
    await wrapper.get('#btn-planning-actions').trigger('click')

    // It is the original slot that gets corrected, and the projection follows: a
    // menu on the copy would suggest two independent decisions.
    expect(wrapper.get('[data-slot="pause-2"]').text()).toContain('héritée')
    expect(wrapper.find('[data-session-action="pause-2"]').exists()).toBe(false)
  })

  it('saves a decision and reads the program back from the hub', async () => {
    const { calls, wrapper } = await mountView()
    await wrapper.get('#btn-planning-actions').trigger('click')

    await wrapper.get('[data-session-action="talk-1"]').setValue('break')
    await flushPromises()

    expect(calls).toContainEqual({
      path: 'sessions/override',
      input: { sessionId: 'talk-1', action: 'break' },
    })
    // Read back rather than rebuilt: the hub serves the corrected program, and a
    // local reconstruction would drift from what the rooms see.
    expect(calls.filter((call) => call.path === 'program/planning')).toHaveLength(2)
  })

  it('does not leave the menu on a decision the hub refused', async () => {
    const { calls, wrapper } = await mountView({ overrideError: 'Programme verrouillé' })
    await wrapper.get('#btn-planning-actions').trigger('click')

    await wrapper.get('[data-session-action="talk-1"]').setValue('break')
    await flushPromises()

    // Nothing changed on the hub side: reloading would be a round trip for nothing,
    // and the data would come back identical — so without patching the menu, which
    // Vue would leave on the clicked option. We put it back by hand.
    expect(calls.filter((call) => call.path === 'program/planning')).toHaveLength(1)
    const menu = wrapper.get('[data-session-action="talk-1"]').element as HTMLSelectElement
    expect(menu.value).toBe('')
  })

  it('leaves the Feedback cell empty rather than offer a dead link', async () => {
    const { wrapper } = await mountView({ sessions: [PAUSE] })

    // With no project set, or on a break, there is nothing to rate.
    expect(wrapper.find('[data-slot="pause-1"] a').exists()).toBe(false)
  })

  it('offers no take on a break', async () => {
    const { wrapper } = await mountView({ sessions: [TALK, PAUSE] })

    // Nobody looks for the lunch's footage, and a button opening an empty modal on
    // twenty-seven rows would cast doubt on all twenty-seven.
    expect(wrapper.find('[data-vod-session="talk-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-vod-session="pause-1"]').exists()).toBe(false)
  })

  it('reports a corrected feedback identifier', async () => {
    const { wrapper } = await mountView({
      sessions: [{ ...TALK, feedbackIdOverride: 'vue-et-les-regies' }],
    })

    expect(wrapper.get('[data-feedback-session="talk-1"]').text()).toContain('✱')
  })

  it('warns when no OpenFeedback project is set', async () => {
    const { wrapper } = await mountView({ projectId: null })

    // With no project, the rooms project no "notez ce talk" QR — and nothing else
    // would say so.
    expect(wrapper.get('#planning-feedback-hint').text()).toContain('Aucun projet OpenFeedback')
  })

  it('queries OpenFeedback only on request', async () => {
    const { calls, wrapper } = await mountView()

    expect(calls.filter((a) => a.path === 'program/controleOpenFeedback')).toHaveLength(0)

    await wrapper.get('#btn-check-feedback').trigger('click')
    await flushPromises()

    expect(calls.filter((a) => a.path === 'program/controleOpenFeedback')).toHaveLength(1)
    expect(wrapper.get('#check-feedback').text()).toContain('27 talks')
  })

  it('offers the actions the lifecycle table allows, and no others', async () => {
    const { wrapper } = await mountView({
      states: [
        {
          sessionId: 'talk-1',
          roomName: 'Track #1',
          title: 'Vue et les régies',
          status: 'running',
          remainingMs: 120_000,
        },
      ],
    })

    const row = wrapper.get('[data-session="talk-1"]')
    // `running`: it can be ended, not started.
    expect(row.text()).toContain('Terminer')
    expect(row.text()).not.toContain('Commencer')
  })

  it('highlights the overrun: it is what triggers a decision', async () => {
    const { wrapper } = await mountView({
      states: [{ sessionId: 'talk-1', status: 'running', remainingMs: -180_000 }],
    })

    const row = wrapper.get('[data-session="talk-1"]')
    expect(row.text()).toContain('+3 min')
    expect(row.html()).toContain('text-alert')
  })

  it('names who decided, not only that it was automatic', async () => {
    const { wrapper } = await mountView({
      states: [{ sessionId: 'talk-1', status: 'ended', decidedBy: 'regie@cloudnord.fr' }],
    })

    // "I did not do that" is the first question asked in front of this row.
    expect(wrapper.get('[data-session="talk-1"]').text()).toContain('regie@cloudnord.fr')
  })
})
