import type { SessionStatus } from '@cloudnord/contract'
import { NO_EDITING_MARKS } from '@cloudnord/contract'
import { useToast } from '@cloudnord/components'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TalkPanel from '../src/components/TalkPanel.vue'
import { TOO_EARLY_MS, useTalkStore } from '../src/stores/talk.js'
import { useRoomStore } from '../src/stores/room.js'
import { START_MS, END_MS, config, payload, speaker, talk } from './fixtures.js'

/**
 * Starting and ending, and the four questions that get in the way.
 *
 * These are the day's two gestures that cannot be undone with a click: one writes
 * a talk down as held at a given hour, the other closes it in front of the other
 * control apps. Their order — earliness before recording — is the heart of the
 * matter, not an implementation detail.
 */

interface Send {
  body: unknown
}

let sends: Send[]
let refuse: string | null

function stubFetch(): void {
  sends = []
  refuse = null
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { action: string }
    sends.push({ body })
    const ok = body.action !== refuse
    return new Response(JSON.stringify({ ok, message: ok ? 'Fait' : 'Refusé' }), {
      headers: { 'content-type': 'application/json' },
    })
  })
}

/** A room placed at a given instant, with the clock stopped there. */
function roomAt(atMs: number, overrides: Record<string, unknown> = {}): void {
  const view = payload()
  Object.assign(view.state, overrides)
  // The offset carries the room's time: the store reads `clock.real + offset`, and
  // the clock does not advance by itself in a test.
  view.state.serverTimeOffsetMs = atMs - Date.now()
  useRoomStore().seed(view)
}

const actions = (): string[] => sends.map((send) => (send.body as { action: string }).action)

beforeEach(() => {
  setActivePinia(createPinia())
  useToast().clear()
  stubFetch()
})

describe('starting', () => {
  it('starts without asking anything when the hour is close', async () => {
    roomAt(START_MS - 60_000)
    // The take is already running: the other guard has nothing to say, and it is
    // the early-start one being looked at here.
    useRoomStore().payload!.diagnostics!.recording = {
      active: true,
      markers: 0,
      startedAtMs: 0,
      startedAtCorrectedMs: null,
      editing: NO_EDITING_MARKS,
    }
    const talkStore = useTalkStore()

    talkStore.askStart()
    await flushPromises()

    // Starting a minute early is the normal morning gesture: confirming it every
    // time would turn it into a reflex.
    expect(talkStore.tooEarlyOpen).toBe(false)
    expect(actions()).toEqual(['session.start', 'scene.set'])
  })

  it('asks for confirmation very early, and says by how much', async () => {
    roomAt(START_MS - TOO_EARLY_MS - 60_000)
    const talkStore = useTalkStore()

    talkStore.askStart()
    await flushPromises()

    /*
     * One "Commencer" too many wrote a talk as held from 08:45 to 08:45 — a slot
     * marked as having taken place while the room was empty.
     */
    expect(talkStore.tooEarlyOpen).toBe(true)
    expect(actions()).toEqual([])
    expect(talkStore.tooEarlyDetail).toContain('16 min')
    expect(talkStore.tooEarlyDetail).toContain('est au programme à')
  })

  it('asks the earliness question before the recording one', async () => {
    roomAt(START_MS - TOO_EARLY_MS - 60_000)
    const talkStore = useTalkStore()

    talkStore.askStart()
    await flushPromises()

    /*
     * One is about the talk being started, the other about how to start it. The
     * other way round, a take would start for a talk one is about to decline to
     * start.
     */
    expect(talkStore.tooEarlyOpen).toBe(true)
    expect(talkStore.recordingOpen).toBe(false)
  })
})

describe('the take warning', () => {
  it('settles when nothing is recording', async () => {
    roomAt(START_MS)
    const talkStore = useTalkStore()

    talkStore.askStart()
    await flushPromises()

    // The question only makes sense beforehand: once the talk has started, a
    // recording begun now will always miss the first few minutes.
    expect(talkStore.recordingOpen).toBe(true)
    expect(actions()).toEqual([])
  })

  it('stays silent when the take is already running', async () => {
    roomAt(START_MS)
    const room = useRoomStore()
    room.payload!.diagnostics!.recording = {
      active: true,
      markers: 0,
      startedAtMs: 0,
      startedAtCorrectedMs: null,
      editing: NO_EDITING_MARKS,
    }
    const talkStore = useTalkStore()

    talkStore.askStart()
    await flushPromises()

    expect(talkStore.recordingOpen).toBe(false)
    expect(actions()).toEqual(['session.start', 'scene.set'])
  })

  it('stays silent when the room has unticked the guard', async () => {
    roomAt(START_MS)
    const room = useRoomStore()
    room.payload!.diagnostics!.config = config({ promptRecordingOnStart: false })
    const talkStore = useTalkStore()

    talkStore.askStart()
    await flushPromises()

    expect(talkStore.recordingOpen).toBe(false)
  })

  it('keeps the guard while the setting has not arrived yet', async () => {
    roomAt(START_MS)
    const talkStore = useTalkStore()

    talkStore.askStart()
    await flushPromises()

    // Reading a missing field as "do nothing" would silently disable a guard,
    // which is exactly what it is meant to prevent.
    expect(talkStore.recordingOpen).toBe(true)
  })

  it('enregistre d’abord, et seulement s’il part', async () => {
    roomAt(START_MS)
    const talkStore = useTalkStore()
    refuse = 'recording.start'

    await talkStore.launch(true)

    // Beginning anyway would make the warning a lie the next time round: it would
    // have said "recording" of a talk that was not.
    expect(actions()).toEqual(['recording.start'])
  })

  it('chains take, talk, then scene', async () => {
    roomAt(START_MS)
    const talkStore = useTalkStore()

    await talkStore.launch(true)

    // The scene after the start: a switch with no talk started would leave the
    // room on air over nothing.
    expect(actions()).toEqual(['recording.start', 'session.start', 'scene.set'])
  })

  it('switches no scene when the room chose not to switch', async () => {
    roomAt(START_MS)
    useRoomStore().payload!.diagnostics!.config = config({ sceneOnStart: null })
    const talkStore = useTalkStore()

    await talkStore.launch(false)

    // `null` is an explicit choice, distinct from a missing setting.
    expect(actions()).toEqual(['session.start'])
  })
})

describe('ending', () => {
  it('ends without asking anything on time or in overrun', async () => {
    roomAt(END_MS + 60_000)
    const talkStore = useTalkStore()

    talkStore.askEnd()
    await flushPromises()

    // Ending on time is the day's normal gesture: confirming it every time would
    // amount to no longer reading it at all.
    expect(talkStore.endEarlyOpen).toBe(false)
    expect(actions()).toEqual(['session.end'])
  })

  it('asks for confirmation when early, and says what it changes', async () => {
    roomAt(END_MS - 8 * 60_000)
    const talkStore = useTalkStore()

    talkStore.askEnd()
    await flushPromises()

    expect(talkStore.endEarlyOpen).toBe(true)
    expect(actions()).toEqual([])
    expect(talkStore.endEarlyDetail).toContain('8 min')
    expect(talkStore.endEarlyDetail).toContain('les autres régies le verront')
  })

  it('asks nothing on a slot with no end time', async () => {
    const view = payload({ sessions: [talk({ endsAtMs: null })] })
    view.state.targetSession = talk({ endsAtMs: null })
    view.state.serverTimeOffsetMs = START_MS - Date.now()
    useRoomStore().seed(view)
    const talkStore = useTalkStore()

    talkStore.askEnd()
    await flushPromises()

    // No earliness possible: nothing to ask.
    expect(talkStore.endEarlyOpen).toBe(false)
    expect(actions()).toEqual(['session.end'])
  })
})

/**
 * The take forgotten at "Terminer".
 *
 * It is visible nowhere: nothing blinks, the indicator says "recording" as it did
 * during the talk. It runs through the break, the next talk is written into the
 * same file — under the previous one's title and speakers — and the start-up guard
 * stays silent, since a take is running. The price is only discovered at editing
 * time.
 */
describe('stopping the take while ending', () => {
  /** A room at the end of its slot, take running. */
  function recording(atMs = END_MS + 60_000): void {
    roomAt(atMs)
    useRoomStore().payload!.diagnostics!.recording = {
      active: true,
      markers: 2,
      startedAtMs: START_MS,
      startedAtCorrectedMs: null,
      editing: NO_EDITING_MARKS,
    }
  }

  it('offers to stop, and ends nothing before the answer', async () => {
    recording()
    const talkStore = useTalkStore()

    talkStore.askEnd()
    await flushPromises()

    expect(talkStore.stopRecordingOpen).toBe(true)
    expect(actions()).toEqual([])
    expect(talkStore.stopRecordingDetail).toContain('enregistre encore')
    expect(talkStore.stopRecordingDetail).toContain('le même fichier')
  })

  it('stops first, and ends afterwards', async () => {
    recording()
    const talkStore = useTalkStore()
    talkStore.askEnd()
    await flushPromises()

    await talkStore.finish(true)

    // The order matters: ending first would leave the take running with nothing
    // ever putting it down.
    expect(actions()).toEqual(['recording.stop', 'session.end'])
    expect(talkStore.stopRecordingOpen).toBe(false)
  })

  it('does not end if the stop fails', async () => {
    recording()
    refuse = 'recording.stop'
    const talkStore = useTalkStore()

    await talkStore.finish(true)

    expect(actions()).toEqual(['recording.stop'])
  })

  it('allows ending without stopping, for a talk recorded in one go', async () => {
    recording()
    const talkStore = useTalkStore()
    talkStore.askEnd()
    await flushPromises()

    await talkStore.finish(false)

    expect(actions()).toEqual(['session.end'])
  })

  it('asks nothing when no take is running', async () => {
    roomAt(END_MS + 60_000)
    const talkStore = useTalkStore()

    talkStore.askEnd()
    await flushPromises()

    expect(talkStore.stopRecordingOpen).toBe(false)
    expect(actions()).toEqual(['session.end'])
  })

  it('asks the earliness question before the take one', async () => {
    // The first is about the talk being ended, the second about how to end it:
    // cutting the take of a talk one is about to decline to end would be the worse
    // of the two orders.
    recording(END_MS - 8 * 60_000)
    const talkStore = useTalkStore()

    talkStore.askEnd()
    await flushPromises()
    expect(talkStore.endEarlyOpen).toBe(true)
    expect(talkStore.stopRecordingOpen).toBe(false)

    await talkStore.end()

    expect(talkStore.endEarlyOpen).toBe(false)
    expect(talkStore.stopRecordingOpen).toBe(true)
    expect(actions()).toEqual([])
  })

  it('stays silent when the room has unticked the guard', async () => {
    recording()
    useRoomStore().payload!.diagnostics!.config = config({ promptRecordingOnStop: false })
    const talkStore = useTalkStore()

    talkStore.askEnd()
    await flushPromises()

    expect(talkStore.stopRecordingOpen).toBe(false)
    expect(actions()).toEqual(['session.end'])
  })

  it('keeps the guard while the setting has not arrived yet', async () => {
    recording()
    useRoomStore().payload!.diagnostics!.config = null
    const talkStore = useTalkStore()

    talkStore.askEnd()
    await flushPromises()

    // Reading a missing field as "do nothing" would silently disable a guard,
    // which is exactly what it is meant to prevent.
    expect(talkStore.stopRecordingOpen).toBe(true)
  })
})

describe('talk panel', () => {
  function mountPanel(atMs: number, states: Record<string, SessionStatus> = {}) {
    const view = payload()
    view.state.sessionStates = states
    return mount(TalkPanel, { props: { payload: view, nowMs: atMs } })
  }

  it('refuses a gesture the hub would refuse, and says why', () => {
    const wrapper = mountPanel(START_MS)

    // The lifecycle table is the one the hub applies on write: an active button
    // whose procedure would refuse the gesture is no longer possible.
    const end = wrapper.get('#btn-talk-end')
    expect(end.attributes('disabled')).toBeDefined()
    expect(end.attributes('title')).toBeTruthy()
  })

  it('names what the countdown aims at once the talk has ended', () => {
    const following = talk({ id: 'talk-2', startsAtMs: END_MS + 900_000, endsAtMs: null })
    const view = payload({ sessions: [talk(), following] })
    view.state.sessionStates = { 'talk-1': 'ended' }
    const wrapper = mount(TalkPanel, { props: { payload: view, nowMs: END_MS } })

    /*
     * The large number counts down to the next talk, while the "Suivant" line
     * announces the next *slot* — which may be a break. The two differed with
     * nothing to explain it.
     */
    expect(wrapper.get('[data-role="talk-detail"]').text()).toContain(
      'Prochaine conférence à',
    )
    expect(wrapper.get('[data-role="talk-detail"]').text()).toContain('Remettre à venir')
  })

  it('paints the overrun in alert: it is what triggers a decision', () => {
    const wrapper = mountPanel(END_MS + 600_000, { 'talk-1': 'running' })

    expect(wrapper.get('[data-role="talk-detail"]').text()).toContain('dépassement de')
    expect(wrapper.get('[data-role="talk-detail"]').classes()).toContain('text-alert')
  })

  it('says there is nothing to drive rather than leave an empty title', () => {
    const view = payload()
    view.state.targetSession = null
    const wrapper = mount(TalkPanel, { props: { payload: view, nowMs: START_MS } })

    expect(wrapper.get('[data-role="talk-title"]').text()).toBe(
      'Aucune conférence à piloter',
    )
    expect(wrapper.get('#btn-talk-start').attributes('disabled')).toBeDefined()
  })

  it('announces the hour before the title while the slot has not begun', () => {
    const view = payload()
    view.state.targetIsUpcoming = true
    const wrapper = mount(TalkPanel, { props: { payload: view, nowMs: START_MS - 600_000 } })

    expect(wrapper.get('[data-role="talk-title"]').text()).toContain('·')
    expect(wrapper.get('[data-role="talk-detail"]').text()).toContain(
      'Pas encore commencée au programme',
    )
  })

  it('says nothing follows any more, rather than say nothing', () => {
    expect(mountPanel(START_MS).get('[data-role="next"]').text()).toBe('Plus rien après au programme.')
  })
})

describe('speakers', () => {
  it('separates them when there are several', () => {
    const view = payload()
    view.state.targetSession = talk({
      speakers: [speaker('Steven'), speaker('Nuno')],
    })
    const wrapper = mount(TalkPanel, { props: { payload: view, nowMs: START_MS } })

    expect(wrapper.text()).toContain('Steven · Nuno')
  })

  it('withdraws on a slot with no speaker, rather than leave a blank', () => {
    // An empty line under "Pause déjeuner" would send people looking for a missing name.
    const view = payload()
    view.state.targetSession = talk({ kind: 'break', speakers: [] })
    const wrapper = mount(TalkPanel, { props: { payload: view, nowMs: START_MS } })

    expect(wrapper.text()).not.toContain('·')
  })

  it('gives the next talk\'s one too', () => {
    const following = talk({
      id: 'talk-2',
      title: 'Blind ops',
      startsAtMs: END_MS + 600_000,
      endsAtMs: null,
      speakers: [speaker('Nuno')],
    })
    const view = payload({ sessions: [talk(), following] })
    const wrapper = mount(TalkPanel, { props: { payload: view, nowMs: START_MS } })

    expect(wrapper.get('[data-role="next"]').text()).toContain('Blind ops')
    expect(wrapper.get('[data-role="next"]').text()).toContain('Nuno')
  })
})

describe('both buttons follow the lifecycle table', () => {
  function buttons(status: SessionStatus | null) {
    const view = payload()
    view.state.sessionStates = status == null ? {} : { 'talk-1': status }
    const wrapper = mount(TalkPanel, { props: { payload: view, nowMs: START_MS } })
    return {
      start: wrapper.get('#btn-talk-start'),
      end: wrapper.get('#btn-talk-end'),
    }
  }

  it('says why "Terminer" is closed on a talk that has not started', () => {
    const { start, end } = buttons(null)

    expect(end.attributes('disabled')).toBeDefined()
    expect(end.attributes('title')).toContain("n'a pas été lancée")
    // The gesture that is possible has nothing to explain.
    expect(start.attributes('disabled')).toBeUndefined()
    expect(start.attributes('title')).toBeUndefined()
  })

  it('says why "Commencer" is closed on a running talk', () => {
    const { start, end } = buttons('running')

    expect(start.attributes('title')).toContain('déjà lancée')
    expect(end.attributes('title')).toBeUndefined()
  })

  it('reopens "Commencer" after a close, without going through "Remettre à venir"', () => {
    // A talk closed by the scheduling rule while it was not finished
    // se rattrape d'un geste.
    const { start, end } = buttons('ended')

    expect(start.attributes('disabled')).toBeUndefined()
    expect(end.attributes('title')).toContain('déjà terminée')
  })
})

describe('ended before its slot', () => {
  /** The 09:00 talk has not started, and another follows at 11:00. */
  function beforeTheSlot(statuses: Record<string, SessionStatus>) {
    const next = talk({
      id: 'talk-2',
      title: 'Le talk suivant',
      startsAt: '2026-10-30T11:00:00.000Z',
      startsAtMs: Date.parse('2026-10-30T11:00:00Z'),
      endsAtMs: Date.parse('2026-10-30T11:50:00Z'),
    })
    const view = payload({ sessions: [talk(), next] })
    view.state.targetIsUpcoming = true
    view.state.sessionStates = statuses
    return view
  }

  it('does not name itself as the next talk', () => {
    const view = beforeTheSlot({ 'talk-1': 'ended' })
    const wrapper = mount(TalkPanel, {
      props: { payload: view, nowMs: Date.parse('2026-10-30T08:00:00Z') },
    })

    /*
     * The room named itself: the detail announced "prochaine conférence à 09:50" on
     * the 09:50 talk one had just ended. 11:00 UTC, that is 12:00 in Paris.
     */
    expect(wrapper.get('[data-role="talk-badge"]').text()).toBe('terminée')
    expect(wrapper.get('[data-role="talk-detail"]').text()).toContain('12:00')
    expect(wrapper.get('[data-role="talk-detail"]').text()).not.toContain('10:00')
  })

  it('skips nothing while the talk still holds', () => {
    // With no decision, the next talk stays the slot's — it is what "Commencer"
    // aims at, and the two must name the same one.
    const wrapper = mount(TalkPanel, {
      props: { payload: beforeTheSlot({}), nowMs: Date.parse('2026-10-30T08:00:00Z') },
    })

    expect(wrapper.get('[data-role="talk-badge"]').text()).toBe('à venir')
    expect(wrapper.get('[data-role="talk-detail"]').text()).toContain('Commencer')
  })
})
