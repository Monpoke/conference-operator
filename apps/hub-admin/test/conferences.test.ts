import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ConferencesView from '../src/views/ConferencesView.vue'
import {
  overrideChoice,
  placeInDay,
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
          feedbackId: note('sessions/feedbackId', { ok: true }),
        },
        program: {
          snapshots: note('program/snapshots', [{ active: true }]),
          planning: note('program/planning', {
            sessions: options.sessions ?? [TALK],
            rooms: [{ id: 'track-1', name: 'Track #1' }],
            timezone: PARIS,
            serverTime: options.serverTime ?? '2026-10-30T08:00:00Z',
            openFeedbackProjectId: options.projectId === undefined ? 'cloudnord' : options.projectId,
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
