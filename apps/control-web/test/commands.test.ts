import type { ControlDiagnostics } from '@conference-operator/contract'
import { NO_EDITING_MARKS } from '@conference-operator/contract'
import { useToast } from '@conference-operator/components'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AudioInputsPanel from '../src/components/AudioInputsPanel.vue'
import CapturePanel from '../src/components/CapturePanel.vue'
import MessagePanel from '../src/components/MessagePanel.vue'
import ProjectionPanel from '../src/components/ProjectionPanel.vue'
import ScreenPanel from '../src/components/ScreenPanel.vue'
import { useActionsStore } from '../src/stores/actions.js'
import { useGatewayStore } from '../src/stores/gateway.js'
import { useRoomStore } from '../src/stores/room.js'
import { useSessionStore } from '../src/stores/session.js'
import { obsState, payload } from './fixtures.js'

/**
 * The commands, and the rule that governs them all.
 *
 * None writes into the room's state. The active button describes **where the room
 * stands**, never what has just been asked for — the difference is invisible while
 * everything works, and it matters on exactly the day the switch fails.
 */

interface Call {
  url: string
  body: unknown
}

function stubFetch(response: unknown = { ok: true }): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify(response), {
      headers: { 'content-type': 'application/json' },
    })
  })
  return calls
}

beforeEach(() => {
  setActivePinia(createPinia())
  useToast().clear()
  vi.unstubAllGlobals()
})

describe('poster une action', () => {
  it('writes nothing into the room\'s state', async () => {
    const calls = stubFetch()
    const room = useRoomStore()
    room.seed(payload())
    const before = room.payload?.state.sceneRole

    await useActionsStore().act({ action: 'scene.set', role: 'LIVE' })

    /*
     * Painting ahead would give an active button describing what was asked for and
     * not what is. It is the stream's delta that will repaint, once OBS has really
     * switched.
     */
    expect(calls).toEqual([
      { url: '/control/action', body: { action: 'scene.set', role: 'LIVE' } },
    ])
    expect(room.payload?.state.sceneRole).toBe(before)
  })

  it("repeats the machine's refusal, word for word", async () => {
    stubFetch({ ok: false, message: 'OBS-A ne répond pas' })

    await useActionsStore().act({ action: 'scene.set', role: 'LIVE' })

    // The message is written for the operator, by the layer that knows why it is
    // refused. Translating it here would lose its only handle.
    expect(useToast().notices.value.at(-1)).toMatchObject({
      text: 'OBS-A ne répond pas',
      failed: true,
    })
  })

  it('names the local failure, which is not a hub failure', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('injoignable')
    })

    const result = await useActionsStore().act({ action: 'recording.start' })

    // A failure here does not mean "the hub is far away": the room's application
    // core no longer answers, and that is the failure that stops everything.
    expect(result).toEqual({ ok: false, message: 'Le service local ne répond pas' })
    expect(useToast().notices.value.at(-1)?.failed).toBe(true)
  })
})

describe('room screen', () => {
  it('marks the mode in force, not the one just clicked', async () => {
    const calls = stubFetch()
    const wrapper = mount(ScreenPanel, { props: { mode: 'loop' } })

    await wrapper.get('[data-command="sponsors"]').trigger('click')
    await flushPromises()

    expect(calls[0]?.body).toEqual({ action: 'display.set', mode: 'sponsors' })
    // The loop stays marked: the stream said nothing else.
    expect(wrapper.get('[data-command="loop"]').classes()).toContain('bg-brand')
    expect(wrapper.get('[data-command="sponsors"]').classes()).not.toContain('bg-brand')
  })
})

describe('projection', () => {
  it('offers the relay only where it is configured', () => {
    const unset = mount(ProjectionPanel, {
      props: { sceneRole: 'HOLD', relaySourceRoomId: null, obs: null },
    })
    expect(unset.find('[data-command="RELAY"]').exists()).toBe(false)

    const configured = mount(ProjectionPanel, {
      props: { sceneRole: 'HOLD', relaySourceRoomId: 'track-2', obs: null },
    })

    // "Relais → track-2" rather than a button nobody knows what it shows.
    expect(configured.get('[data-command="RELAY"]').text()).toContain('Relais → track-2')
  })

  it('says nothing of a switch made in the room', async () => {
    const calls = stubFetch({ ok: true, message: 'Scène : LIVE' })
    const wrapper = mount(ProjectionPanel, {
      props: { sceneRole: 'HOLD', relaySourceRoomId: null, obs: null },
    })

    await wrapper.get('[data-command="LIVE"]').trigger('click')
    await flushPromises()

    /*
     * The gesture left, and it announced nothing.
     *
     * On the room's machine the answer comes back in milliseconds and the button
     * repaints itself: "Scène : LIVE" only doubles what the operator is already
     * looking at. Hunting for a shot during a talk used to leave four green
     * rectangles stacked at the bottom of a screen in a dark room.
     */
    expect(calls[0]?.body).toEqual({ action: 'scene.set', role: 'LIVE' })
    expect(useToast().notices.value).toEqual([])
  })

  it('still says a switch that was refused', async () => {
    stubFetch({ ok: false, message: 'OBS-A ne répond pas' })

    await useActionsStore().act({ action: 'scene.set', role: 'LIVE' })

    // The silence covers the success only: a refusal has no visible effect to
    // say it in its place.
    expect(useToast().notices.value.at(-1)).toMatchObject({
      text: 'OBS-A ne répond pas',
      failed: true,
    })
  })

  it('leaves one notice when the switches follow one another', async () => {
    stubFetch({ ok: false, message: 'OBS-A ne répond pas' })
    const actions = useActionsStore()

    await actions.act({ action: 'scene.set', role: 'LIVE' })
    await actions.act({ action: 'scene.set', role: 'HOLD' })
    await actions.act({ action: 'scene.set', role: 'LIVE' })

    // One refusal restated three times is one incident, not three: the later
    // notice takes the earlier one's place.
    expect(useToast().notices.value).toHaveLength(1)
  })

  it('greys out the scenes, and says why, when OBS-A is not connected', async () => {
    const calls = stubFetch()
    const wrapper = mount(ProjectionPanel, {
      props: { sceneRole: 'HOLD', relaySourceRoomId: null, obs: null, offline: true },
    })

    // Better to say it before the click than to answer with a red refusal after.
    expect(wrapper.get('[data-role="obs-offline"]').text()).toContain("OBS\u00a0A n'est pas connecté")
    expect(wrapper.get('[data-command="LIVE"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-command="LIVE"]').trigger('click')
    await flushPromises()
    expect(calls).toEqual([])
  })

  it('leaves the scenes alone when OBS-A is connected', () => {
    const wrapper = mount(ProjectionPanel, {
      props: { sceneRole: 'HOLD', relaySourceRoomId: null, obs: null },
    })
    expect(wrapper.find('[data-role="obs-offline"]').exists()).toBe(false)
    expect(wrapper.get('[data-command="LIVE"]').attributes('disabled')).toBeUndefined()
  })

  it('reminds that a simulated instance captures nothing', () => {
    const wrapper = mount(ProjectionPanel, {
      props: {
        sceneRole: 'LIVE',
        relaySourceRoomId: null,
        obs: obsState({ simulated: true }),
      },
    })

    // Nothing on screen tells simulated driving from real, except that no camera is
    // plugged in behind it.
    expect(wrapper.text()).toContain('simulé')
  })
})

/**
 * The same gesture, on the other side of the network.
 *
 * From a phone the round trip costs seconds and the button repaints only at the
 * next poll: the notice is the one sign the gesture was heard, and taking it
 * away there would leave one pressing twice. It stays — keyed, so that a hand
 * running through the shots leaves one line and not four.
 */
describe('projection, from a phone', () => {
  it('confirms the switch, keeping only the last', async () => {
    const sent: unknown[] = []
    // With no token the session store asks the hub whether a cookie is left:
    // answering "nobody" beats leaving the call hanging until teardown.
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }))

    const gateway = useGatewayStore()
    gateway.start({ portee: 'distante', roomId: 'track-1', salles: [], google: null, version: null })
    useSessionStore().client = {
      rpc: {
        regie: {
          view: async () => ({ lock: null }),
          command: async ({ action }: { action: unknown }) => {
            sent.push(action)
            return { ok: true, applied: 'queued' as const }
          },
        },
      },
    } as never

    const actions = useActionsStore()
    await actions.act({ action: 'scene.set', role: 'LIVE' })
    await actions.act({ action: 'scene.set', role: 'HOLD' })

    expect(sent).toEqual([
      { type: 'scene.set', role: 'LIVE' },
      { type: 'scene.set', role: 'HOLD' },
    ])
    expect(useToast().notices.value).toHaveLength(1)
  })
})

describe('audio sources', () => {
  const INPUTS = [
    { name: 'Micro cravate', muted: { A: false, B: false } },
    { name: 'Micro main', muted: { A: true, B: true } },
    { name: 'Ambiance salle', muted: { A: false, B: true } },
  ]

  it('offers to cut what is live, and to restore what is cut', async () => {
    const calls = stubFetch()
    const wrapper = mount(AudioInputsPanel, { props: { inputs: INPUTS } })

    expect(wrapper.get('[data-input="Micro main"]').text()).toContain('Coupé')
    await wrapper.get('[data-input="Micro cravate"] button').trigger('click')
    await wrapper.get('[data-input="Micro main"] button').trigger('click')
    await flushPromises()

    // A state and not a toggle: the button says what it asks for.
    expect(calls.map((call) => call.body)).toEqual([
      { action: 'audio.mute', input: 'Micro cravate', muted: true },
      { action: 'audio.mute', input: 'Micro main', muted: false },
    ])
  })

  it('shows a source cut on one instance only, and cuts it everywhere', async () => {
    const calls = stubFetch()
    const wrapper = mount(AudioInputsPanel, { props: { inputs: INPUTS } })

    // Heard in the room and not in the VOD: exactly what has to be seen.
    expect(wrapper.get('[data-input="Ambiance salle"]').text()).toContain('OBS B seulement')

    await wrapper.get('[data-input="Ambiance salle"] button').trigger('click')
    await flushPromises()
    expect(calls[0]?.body).toEqual({ action: 'audio.mute', input: 'Ambiance salle', muted: true })
  })

  it('greys out the buttons, and says why, when no OBS is connected', async () => {
    const calls = stubFetch()
    const wrapper = mount(AudioInputsPanel, { props: { inputs: INPUTS, offline: true } })

    expect(wrapper.find('[data-role="audio-offline"]').exists()).toBe(true)
    expect(wrapper.get('[data-input="Micro main"] button').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-input="Micro main"] button').trigger('click')
    await flushPromises()
    expect(calls).toEqual([])
  })
})

describe('message to the console', () => {
  it('sends no empty message, nor whitespace', async () => {
    const calls = stubFetch()
    const wrapper = mount(MessagePanel)

    await wrapper.get('#message-text').setValue('   ')
    await wrapper.get('#btn-message').trigger('click')
    await flushPromises()

    expect(calls).toEqual([])
  })

  it('leaves with its level, and clears the field', async () => {
    const calls = stubFetch()
    const wrapper = mount(MessagePanel)

    await wrapper.get('#message-text').setValue('Le micro coupe')
    await wrapper.get('#message-level').setValue('urgent')
    await wrapper.get('#message-text').trigger('keydown.enter')
    await flushPromises()

    expect(calls[0]?.body).toEqual({
      action: 'message.send',
      text: 'Le micro coupe',
      level: 'urgent',
    })
    expect((wrapper.get('#message-text').element as HTMLInputElement).value).toBe('')
  })
})

describe('captation', () => {
  const REC = { active: true, markers: 2, startedAtMs: 1_000, startedAtCorrectedMs: null, editing: NO_EDITING_MARKS }

  function mountPanel(
    recording: ControlDiagnostics['recording'] | null,
    streaming = false,
    // A room the hub has given a destination, unless a test says otherwise:
    // that is the ordinary state, and the absence is what deserves the override.
    stream: { rtmpUrl: string } | null | undefined = { rtmpUrl: 'rtmp://live/app' },
  ): ReturnType<typeof mount> {
    return mount(CapturePanel, {
      props: { recording, streaming, obs: null, realMs: 61_000, roomMs: 61_000, stream },
    })
  }

  it('offers to stop what is running, and to start what is not', () => {
    expect(mountPanel(REC).get('#btn-rec').text()).toContain('Arrêter')
    expect(mountPanel(null).get('#btn-rec').text()).toContain('Enregistrer')
  })

  it('posts the stop when it is running, the start otherwise', async () => {
    const calls = stubFetch()

    await mountPanel(REC).get('#btn-rec').trigger('click')
    await mountPanel(null).get('#btn-rec').trigger('click')
    await flushPromises()

    expect(calls.map((call) => call.body)).toEqual([
      { action: 'recording.stop' },
      { action: 'recording.start' },
    ])
  })

  it('greys out every command, and says why, when OBS-B is not connected', async () => {
    const calls = stubFetch()
    const wrapper = mount(CapturePanel, {
      props: { recording: REC, streaming: false, canStream: true, obs: null, realMs: 61_000, roomMs: 61_000, offline: true },
    })

    expect(wrapper.get('[data-role="obs-offline"]').text()).toContain("OBS\u00a0B n'est pas connecté")
    for (const id of ['#btn-rec', '#btn-stream', '#btn-marker', '#btn-anchor-start', '#btn-anchor-end']) {
      expect(wrapper.get(id).attributes('disabled')).toBeDefined()
    }

    // The shortcuts reach these functions without the button: they refuse too.
    const exposed = wrapper.vm as unknown as { toggleRecording(): void; mark(): void; anchor(role: 'debut'): void }
    exposed.toggleRecording()
    exposed.mark()
    exposed.anchor('debut')
    await flushPromises()
    expect(calls).toEqual([])
  })

  it('does not allow a marker to be laid outside a recording', () => {
    const wrapper = mountPanel(null)

    // A marker with no take attaches to nothing: the machine would refuse it, and
    // an active button whose command is refused is a trap.
    expect(wrapper.get('#btn-marker').attributes('disabled')).toBeDefined()
    expect(wrapper.get('#label-marker').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-role="markers"]').text()).toBe('hors enregistrement')
  })

  it('marks with no label rather than not marking', async () => {
    const calls = stubFetch()
    const wrapper = mountPanel(REC)

    await wrapper.get('#btn-marker').trigger('click')
    await flushPromises()

    // At editing time, knowing *where* is already better than nothing, and
    // rater l'instant.
    expect(calls[0]?.body).toEqual({ action: 'recording.mark', label: 'Chapitre' })
  })

  it('takes the typed label, and clears the field', async () => {
    const calls = stubFetch()
    const wrapper = mountPanel(REC)

    await wrapper.get('#label-marker').setValue('Questions')
    await wrapper.get('#btn-marker').trigger('click')
    await flushPromises()

    expect(calls[0]?.body).toEqual({ action: 'recording.mark', label: 'Questions' })
    expect((wrapper.get('#label-marker').element as HTMLInputElement).value).toBe('')
  })

  /*
   * The two editing anchors, seen from the panel.
   *
   * What counts here: the role leaves with the gesture, and the label is not typed.
   * The machine only reads `role`; the label, for its part, is read back in the
   * hub's log and must say the same thing from one room to the next.
   */
  it('posts both anchors with their role, without going through the field', async () => {
    const calls = stubFetch()
    const wrapper = mountPanel(REC)

    await wrapper.get('#btn-anchor-start').trigger('click')
    await wrapper.get('#btn-anchor-end').trigger('click')
    await flushPromises()

    expect(calls.map((call) => call.body)).toEqual([
      { action: 'recording.mark', label: 'Début', role: 'debut' },
      { action: 'recording.mark', label: 'Fin', role: 'fin' },
    ])
  })

  it('shows where the anchor fell, not only that it is set', () => {
    const wrapper = mountPanel({ ...REC, editing: { startMs: 52_000, endMs: null } })

    // "Set" and "set where" are two questions, and the second is the one asked
    // when hesitating over setting the anchor again.
    expect(wrapper.get('#btn-anchor-start').text()).toContain('Début · 00:52')
    expect(wrapper.get('#btn-anchor-end').text()).not.toContain('·')
  })

  it('does not allow an anchor to be set outside a recording', () => {
    const wrapper = mountPanel(null)

    expect(wrapper.get('#btn-anchor-start').attributes('disabled')).toBeDefined()
    expect(wrapper.get('#btn-anchor-end').attributes('disabled')).toBeDefined()
  })

  it('counts the markers set', () => {
    expect(mountPanel(REC).get('[data-role="markers"]').text()).toBe('2 marqueur(s)')
    expect(mountPanel({ ...REC, markers: 0 }).get('[data-role="markers"]').text()).toBe(
      'aucun marqueur',
    )
  })

  it('toggles the stream in the direction it is not in', async () => {
    const calls = stubFetch()

    await mountPanel(null, true).get('#btn-stream').trigger('click')
    await mountPanel(null, false).get('#btn-stream').trigger('click')
    await flushPromises()

    expect(calls.map((call) => call.body)).toEqual([
      { action: 'stream.stop' },
      { action: 'stream.start' },
    ])
  })

  it('does not offer to stream a room the hub gave no destination', async () => {
    /*
     * The setting lives on the hub, in the console. Without this, the room finds
     * out it is missing by pressing the button — in front of the audience, with
     * the talk starting, and OBS answering in its own words to a machine nobody
     * is watching. The refusal is in the handler too, not only on the attribute:
     * the button is also reachable from the page's keyboard shortcuts.
     */
    const calls = stubFetch()
    const wrapper = mountPanel(null, false, null)

    expect(wrapper.get('#btn-stream').attributes('disabled')).toBeDefined()
    expect(wrapper.get('#btn-stream').attributes('title')).toContain('hub')

    await wrapper.get('#btn-stream').trigger('click')
    await flushPromises()
    expect(calls).toEqual([])
  })

  it('still allows a running stream to be cut once the destination is gone', async () => {
    // A button that greyed out while on air would leave the room with no way to
    // stop what is going out.
    const calls = stubFetch()

    await mountPanel(null, true, null).get('#btn-stream').trigger('click')
    await flushPromises()

    expect(calls.map((call) => call.body)).toEqual([{ action: 'stream.stop' }])
  })

  it('does not grey the button out on a configuration it has not received', async () => {
    // `undefined` is "not known", not "none": the remote page does not carry the
    // room's configuration, and refusing on an absence would refuse a stream that
    // is perfectly well set up.
    const calls = stubFetch()

    await mountPanel(null, false, undefined).get('#btn-stream').trigger('click')
    await flushPromises()

    expect(calls.map((call) => call.body)).toEqual([{ action: 'stream.start' }])
  })
})
