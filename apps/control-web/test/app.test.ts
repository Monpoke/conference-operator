import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlDiagnostics } from '@cloudnord/contract'
import { NO_EDITING_MARKS } from '@cloudnord/contract'
import App from '../src/App.vue'
import { useTalkStore } from '../src/stores/talk.js'
import { useConsultStore } from '../src/stores/consult.js'
import { useRoomStore } from '../src/stores/room.js'
import { payload } from './fixtures.js'

/**
 * The whole page, and the shortcuts that cross it.
 *
 * What is checked here and nowhere else: that a letter typed in the room reaches
 * the right command. Two of them switch the projection in front of an audience.
 */

interface Call {
  url: string
  body: unknown
}

let calls: Call[]
let callCount: number

/*
 * Mounted then unmounted, without exception.
 *
 * The keyboard layer lays a listener on the `document`: a component left mounted
 * from one test to the next keeps its own, and its bindings point at the previous
 * test's room. A keystroke then fired twice, once towards a take that no longer
 * existed.
 */
const mounted: { unmount: () => void }[] = []

function silentStream(): void {
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
}

beforeEach(() => {
  setActivePinia(createPinia())
  calls = []
  silentStream()
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body == null ? null : JSON.parse(String(init.body)) })
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    })
  })
})

async function mountApp(
  recording: ControlDiagnostics['recording'] | null = null,
): Promise<ReturnType<typeof mount>> {
  const etat = payload()
  etat.diagnostics!.recording = recording ?? { active: false, markers: 0, startedAtMs: null, startedAtCorrectedMs: null, editing: NO_EDITING_MARKS }
  useRoomStore().seed(etat)
  const wrapper = mount(App, { attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}

afterEach(() => {
  for (const montee of mounted.splice(0)) montee.unmount()
})

function press(key: string): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

describe('raccourcis de la page', () => {
  it('bascule la projection sans passer par la souris', async () => {
    await mountApp()

    press('l')
    press('h')
    await flushPromises()

    // In a dark room, aiming at a button costs more than pressing a key — and
    // these two get typed while holding the microphone.
    expect(calls.filter((call) => call.url === '/control/action').map((e) => e.body)).toEqual([
      { action: 'scene.set', role: 'LIVE' },
      { action: 'scene.set', role: 'HOLD' },
    ])
  })

  it('lance la captation quand rien ne tourne', async () => {
    await mountApp()

    press('r')
    await flushPromises()

    expect(calls.at(-1)?.body).toEqual({ action: 'recording.start' })
  })

  it('stops the one that is running', async () => {
    await mountApp({ active: true, markers: 0, startedAtMs: 0, startedAtCorrectedMs: null, editing: NO_EDITING_MARKS })

    press('r')
    await flushPromises()

    expect(calls.at(-1)?.body).toEqual({ action: 'recording.stop' })
  })

  it('pose un marqueur pendant une prise', async () => {
    await mountApp({ active: true, markers: 0, startedAtMs: 0, startedAtCorrectedMs: null, editing: NO_EDITING_MARKS })

    press('m')
    await flushPromises()

    expect(calls.at(-1)?.body).toEqual({ action: 'recording.mark', label: 'Chapitre' })
  })

  it('sets both editing anchors from the keyboard', async () => {
    await mountApp({ active: true, markers: 0, startedAtMs: 0, startedAtCorrectedMs: null, editing: NO_EDITING_MARKS })

    // These are gestures made while watching the room, not the screen: the speaker
    // starts, the speaker finishes. Going through the label field
    // ferait rater l'instant, qui est ici toute l'information.
    press('d')
    await flushPromises()
    expect(calls.at(-1)?.body).toEqual({ action: 'recording.mark', label: 'Début', role: 'debut' })

    press('f')
    await flushPromises()
    expect(calls.at(-1)?.body).toEqual({ action: 'recording.mark', label: 'Fin', role: 'fin' })
  })

  it('sets no anchor when nothing is recording', async () => {
    await mountApp()

    press('d')
    press('f')
    await flushPromises()

    expect(calls.filter((call) => call.url === '/control/action')).toEqual([])
  })

  it('ne pose pas de marqueur quand rien n’enregistre', async () => {
    await mountApp()

    press('m')
    await flushPromises()

    // The machine would refuse the command: sending it anyway would flash a
    // failure for a gesture the page knew to be impossible.
    expect(calls.filter((call) => call.url === '/control/action')).toEqual([])
  })

  it('rend la press au champ qui l’attend', async () => {
    const wrapper = await mountApp()
    const champ = wrapper.get('#message-text')

    await champ.setValue('l')
    champ.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }))
    await flushPromises()

    // Typing "le micro coupe" into the message to the console must not switch the
    // projection live on the first character.
    expect(calls.filter((call) => call.url === '/control/action')).toEqual([])
  })
})

describe('window title', () => {
  it('follows the event, and corrects itself on a sync', async () => {
    await mountApp()
    expect(document.title).toBe('Régie — Cloud Nord 2026')

    useRoomStore().payload!.eventIdentity = { name: 'Cloud Nord 2027', shortName: 'CN27' }
    await flushPromises()

    // The same machine will serve next year's edition, and the window bar is the
    // first place a stale name gets noticed.
    expect(document.title).toBe('Régie — Cloud Nord 2027')
  })
})

describe('programmes des salles voisines', () => {
  it('ne les relit pas tant que l’empreinte du programme ne change pas', async () => {
    await mountApp()
    callCount = calls.filter((call) => call.url.startsWith('/display/sessions')).length

    // A state arrives every few seconds; re-reading a dozen programs each time
    // would cost as many requests for an answer
    // identique.
    useRoomStore().payload!.state.outboxDepth = 3
    await flushPromises()

    expect(calls.filter((call) => call.url.startsWith('/display/sessions'))).toHaveLength(callCount)
  })

  it('ne charge la liste qu’une fois au editing', async () => {
    await mountApp()

    // An effect that watches what it writes fires twice: the second round costs
    // nothing visible, but it doubles the day's requests on a machine that asked
    // for nothing.
    expect(calls.filter((call) => call.url === '/display/sessions')).toHaveLength(1)
  })
})

describe('control app in read-only', () => {
  it('mounts with no diagnostics, rather than fail', async () => {
    const etat = payload({ diagnostics: null })
    useRoomStore().seed(etat)
    const wrapper = mount(App, { attachTo: document.body })
    mounted.push(wrapper)
    await flushPromises()

    // A second window opened just to watch: the machine drives nothing, and half
    // the payload is absent.
    expect(wrapper.text()).toContain('Régie en lecture seule')
    expect(wrapper.find('#btn-rec').exists()).toBe(true)
  })
})

describe('consultation', () => {
  it('s’ouvre au clavier, sur l’onglet que la touche nomme', async () => {
    await mountApp()
    const consult = useConsultStore()

    press('p')
    await flushPromises()
    expect(consult.open).toBe(true)
    expect(consult.tab).toBe('program')

    consult.open = false
    // The modal's layer is removed on the next reactive cycle: typing in between
    // would be typing while it is still on screen.
    await flushPromises()
    press('s')
    await flushPromises()
    expect(consult.tab).toBe('rooms')
  })

  it('avale les raccourcis pendant qu’on lit', async () => {
    await mountApp()
    const consult = useConsultStore()
    consult.show('program')
    await flushPromises()

    press('l')
    press('r')
    await flushPromises()

    /*
     * `l` and `h` switch the projection in front of an audience, and an open modal
     * is exactly the moment one types without looking.
     */
    expect(calls.filter((call) => call.url === '/control/action')).toEqual([])
  })

  it('follows a neighbouring room and loads its program on demand', async () => {
    await mountApp()
    const consult = useConsultStore()

    await consult.follow('track-2')
    await flushPromises()

    // Not in the state stream: the program of a room nobody is looking at has no
    // business travelling on every scene change.
    expect(consult.tab).toBe('other')
    expect(calls.some((call) => call.url === '/display/sessions?salle=track-2')).toBe(true)
  })
})

describe('une question ouverte prend le clavier', () => {
  it('answers "yes" to the early end, and nothing else gets through', async () => {
    await mountApp()
    const talk = useTalkStore()
    talk.endEarlyOpen = true
    await flushPromises()

    press('r')
    press('y')
    await flushPromises()

    /*
     * A reflex "r" while being asked whether to end would switch the take
     * underneath the question itself. The layer swallows what it has not bound —
     * which is what six `return`s per modal did in the original page, and which one
     * had to remember to write for each new one.
     */
    expect(calls.filter((call) => call.url === '/control/action').map((e) => e.body)).toEqual([
      { action: 'session.end' },
    ])
  })

  it('accepts "o" as much as "y"', async () => {
    await mountApp()
    const talk = useTalkStore()
    talk.endEarlyOpen = true
    await flushPromises()

    press('o')
    await flushPromises()

    // Half the operators type one, the other half the other, and getting the
    // letter wrong on that question costs a talk.
    expect(calls.at(-1)?.body).toEqual({ action: 'session.end' })
  })

  it('closes on "n" without sending anything', async () => {
    await mountApp()
    const talk = useTalkStore()
    talk.endEarlyOpen = true
    await flushPromises()

    press('n')
    await flushPromises()

    expect(talk.endEarlyOpen).toBe(false)
    expect(calls.filter((call) => call.url === '/control/action')).toEqual([])
  })

  it('answers the keyboard on the take warning too', async () => {
    /*
     * That question answered nothing, while the other two answered `y` and `n`: two
     * questions out of four on the keyboard, and nothing on screen to tell them
     * apart. The keys are now bound by `ConfirmDialog` itself, along with the label
     * it prints — so everywhere, or nowhere.
     */
    await mountApp()
    const talk = useTalkStore()
    talk.recordingOpen = true
    await flushPromises()

    press('y')
    await flushPromises()

    expect(talk.recordingOpen).toBe(false)
    expect(calls.filter((call) => call.url === '/control/action').map((e) => e.body)).toEqual([
      { action: 'recording.start' },
      { action: 'session.start' },
      { action: 'scene.set', role: 'LIVE' },
    ])
  })

  it('leaves the third way out to the mouse', async () => {
    // "Commencer sans enregistrer" is neither cancel nor confirm: giving it a
    // letter would make it a second way of saying yes, to a question whose default
    // answer costs a VOD.
    await mountApp()
    const talk = useTalkStore()
    talk.recordingOpen = true
    await flushPromises()

    for (const touche of ['r', 'l', 'm']) press(touche)
    await flushPromises()

    // And the layer still swallows what it has not bound: a reflex "r" would
    // switch the take underneath the question itself.
    expect(calls.filter((call) => call.url === '/control/action')).toEqual([])
    expect(talk.recordingOpen).toBe(true)
  })
})

describe('avant le premier octet', () => {
  it('says it is waiting, rather than paint an empty room', async () => {
    const wrapper = mount(App)
    await flushPromises()

    expect(wrapper.text()).toContain('Connexion au poste de salle')
  })
})
