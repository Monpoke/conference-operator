import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DisplayPayload } from '@cloudnord/contract'
import App from '../src/App.vue'
import PairingVeil from '../src/components/PairingVeil.vue'
import { useRoomStore } from '../src/stores/room.js'
import { payload } from './fixtures.js'

/**
 * The screen of a machine not yet linked to anything.
 *
 * A state, and not a modal: nothing it covers is usable. A modal closes — on
 * Escape, on a click beside it — and would leave a complete control app on screen,
 * every button of which would fail without saying why.
 */

const ROOMS = [
  { id: 'track-1', name: 'Track #1' },
  { id: 'track-2', name: 'Track #2' },
]

interface Envoi {
  url: string
  body: unknown
}

let sent: Envoi[]
const mounted: { unmount: () => void }[] = []

beforeEach(() => {
  setActivePinia(createPinia())
  sent = []
  vi.stubGlobal(
    'EventSource',
    class {
      onopen: unknown = null
      onerror: unknown = null
      onmessage: unknown = null
      addEventListener(): void {}
      close(): void {}
    },
  )
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    sent.push({ url, body: init?.body == null ? null : JSON.parse(String(init.body)) })
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    })
  })
})

afterEach(() => {
  for (const montee of mounted.splice(0)) montee.unmount()
})

function veil(pairing: DisplayPayload['pairing']): ReturnType<typeof mount> {
  return mount(PairingVeil, { props: { pairing } })
}

describe('choix de la salle', () => {
  it('offers the rooms while no code has been requested', async () => {
    const wrapper = veil({ status: 'idle', rooms: ROOMS })

    await wrapper.get('[data-room="track-2"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Quelle salle dessert ce poste ?')
    expect(sent[0]?.body).toEqual({ action: 'pairing.chooseRoom', roomId: 'track-2' })
  })

  it('says the hub is unreachable rather than show an empty list', () => {
    // An empty list would read as an event with no rooms.
    expect(veil({ status: 'idle', rooms: [] }).text()).toContain('Hub injoignable')
  })
})

describe('code d’appairage', () => {
  it('shows the code and the address to type it into', () => {
    const wrapper = veil({
      status: 'waiting',
      userCode: 'ABCD-1234',
      verificationUri: 'https://hub.example/appairage',
      rooms: ROOMS,
      requestedRoomId: 'track-1',
    })

    expect(wrapper.get('[data-role="pairing-code"]').text()).toBe('ABCD-1234')
    expect(wrapper.text()).toContain('https://hub.example/appairage')
    // The requested room accompanies the code: the console will find it
    // preselected, and the operator must be able to check which one.
    expect(wrapper.text()).toContain('Track #1')
  })

  it('does not claim to know a code it does not have', () => {
    // The field is **absent**, not null: that is what the room produces, and the
    // typing reminded us — a `null` written here described a state it never emits.
    const wrapper = veil({ status: 'waiting', rooms: [] })
    expect(wrapper.find('[data-role="pairing-code"]').exists()).toBe(false)
  })

  it('tells a revoked machine from a new one', () => {
    /*
     * `requestedRoomId` set, because a revoked machine necessarily has one:
     * `repair()` clears the token, not the room served, and `pairingState()` still
     * carries it. Omitting it described a payload the machine does not produce.
     */
    const wrapper = veil({
      status: 'expired',
      userCode: 'ABCD-1234',
      rooms: ROOMS,
      requestedRoomId: 'track-1',
    })

    /*
     * A refused token is not a first start-up: saying so avoids believing in a new
     * machine when it has been revoked, or the hub's database recreated.
     */
    expect(wrapper.text()).toContain('doit être réappairée')
  })

  it('repeats the hub\'s refusal as it is', () => {
    const wrapper = veil({
      status: 'failed',
      userCode: 'ABCD-1234',
      message: 'Salle déjà prise',
      requestedRoomId: 'track-1',
    })
    expect(wrapper.text()).toContain('Salle déjà prise')
  })

  it('asks the room again of a machine that never chose one', () => {
    // The rule's boundary: with no known room the question stands — it is the first
    // start-up, or a machine restarted before ever being paired.
    const wrapper = veil({ status: 'expired', message: 'Jeton refusé', rooms: ROOMS })
    expect(wrapper.text()).toContain('Quelle salle dessert ce poste ?')
  })
})

describe('what the veil covers', () => {
  async function mountVeil(pairing: DisplayPayload['pairing']): Promise<ReturnType<typeof mount>> {
    const etat = payload()
    etat.pairing = pairing
    useRoomStore().seed(etat)
    const wrapper = mount(App, { attachTo: document.body })
    mounted.push(wrapper)
    await flushPromises()
    return wrapper
  }

  it('replaces the control app, instead of sitting on top of it', async () => {
    const wrapper = await mountVeil({ status: 'waiting', userCode: 'ABCD-1234', rooms: ROOMS })

    expect(wrapper.find('[data-role="pairing"]').exists()).toBe(true)
    // No close button, and nothing behind: every control command would fail
    // without saying why on a machine linked to nothing.
    expect(wrapper.find('#btn-rec').exists()).toBe(false)
  })

  it('lifts as soon as it is approved', async () => {
    const wrapper = await mountVeil({ status: 'paired' })

    expect(wrapper.find('[data-role="pairing"]').exists()).toBe(false)
    expect(wrapper.find('#btn-rec').exists()).toBe(true)
  })

  it('does not appear at all on a room already linked', async () => {
    const wrapper = await mountVeil(null)
    expect(wrapper.find('[data-role="pairing"]').exists()).toBe(false)
  })

  it('coupe les raccourcis, qui viseraient un OBS que la machine n’a pas', async () => {
    await mountVeil({ status: 'waiting', userCode: 'ABCD-1234', rooms: ROOMS })

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }))
    await flushPromises()

    /*
     * The original page kept them alive behind the veil — its listener was global
     * and the veil was only an attribute on the `<body>`. Typing "l" collected a red
     * failure for an answer.
     */
    expect(sent.filter((call) => call.url === '/control/action')).toEqual([])
  })
})

/**
 * What happens between two codes.
 *
 * A pairing code lives two minutes by default. Pairing one room, then a second, is
 * enough to let it die before one has finished: the supervision loop asks for
 * another within fifteen seconds, and that is expected. What was not expected is
 * what the control app displays during that gap — it went back to asking which
 * room this machine serves, when the answer had been given long before and still
 * travels in `requestedRoomId`.
 */
describe('between two codes', () => {
  it('does not ask the room again after an expiry', () => {
    const wrapper = veil({
      status: 'failed',
      message: "Le code d'appairage a expiré, relancer l'opération",
      rooms: ROOMS,
      // The machine knows perfectly well which room it serves: it is the choice
      // made before asking for the first code.
      requestedRoomId: 'track-1',
    })
    mounted.push(wrapper)

    expect(wrapper.text()).not.toContain('Quelle salle dessert ce poste ?')
    // And above all: no room button to click again.
    expect(wrapper.find('[data-room="track-2"]').exists()).toBe(false)
  })

  it('says a new code is coming, rather than leave a mute screen', () => {
    const wrapper = veil({
      status: 'failed',
      message: "Le code d'appairage a expiré, relancer l'opération",
      rooms: ROOMS,
      requestedRoomId: 'track-1',
    })
    mounted.push(wrapper)

    // The room served stays named, and the wait is announced: failing which the
    // screen looks like a broken pairing when it is repairing itself.
    expect(wrapper.text()).toContain('Track #1')
    expect(wrapper.get('[data-role="pairing-waiting"]').text()).toContain('nouveau code')
  })

  it('asks the room while none has been chosen', () => {
    // The first start-up does have to ask the question.
    const wrapper = veil({ status: 'idle', rooms: ROOMS, requestedRoomId: null })
    mounted.push(wrapper)

    expect(wrapper.text()).toContain('Quelle salle dessert ce poste ?')
    expect(wrapper.find('[data-room="track-2"]').exists()).toBe(true)
  })
})
