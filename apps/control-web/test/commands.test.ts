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

function stubFetch(reponse: unknown = { ok: true }): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify(reponse), {
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

  it('reprend le refus du poste, mot pour mot', async () => {
    stubFetch({ ok: false, message: 'OBS-A ne répond pas' })

    await useActionsStore().act({ action: 'scene.set', role: 'LIVE' })

    // The message is written for the operator, by the layer that knows why it is
    // refused. Translating it here would lose its only handle.
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

    // A failure here does not mean "the hub is far away": the room's application
    // core no longer answers, and that is the failure that stops everything.
    expect(resultat).toEqual({ ok: false, message: 'Le service local ne répond pas' })
    expect(useToast().notices.value.at(-1)?.failed).toBe(true)
  })
})

describe('room screen', () => {
  it('marque le mode en vigueur, pas celui qu’on vient de cliquer', async () => {
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
  ): ReturnType<typeof mount> {
    return mount(CapturePanel, {
      props: { recording, streaming, obs: null, realMs: 61_000, roomMs: 61_000 },
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

  it('ne laisse pas poser un marqueur hors enregistrement', () => {
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
})
