import type { VisibleConfig, ObsState } from '@conference-operator/contract'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ConfigDialog from '../src/components/ConfigDialog.vue'
import ObsConfigBlock from '../src/components/ObsConfigBlock.vue'
import ScreensMenu from '../src/components/ScreensMenu.vue'
import { useActionsStore } from '../src/stores/actions.js'
import { useConfigStore } from '../src/stores/config.js'
import { useGatewayStore } from '../src/stores/gateway.js'
import { useSessionStore } from '../src/stores/session.js'
import { useRoomStore } from '../src/stores/room.js'
import { obsState, payload } from './fixtures.js'

/**
 * The room's configuration, typed into a draft.
 *
 * The form is populated on opening and never on every state received: the control
 * app gets one every few seconds, and repopulating the fields under the fingers
 * would erase what is being typed.
 */

const CONFIG: VisibleConfig = {
  stream: null,
  // An installed machine: it is the one that can open a picker.
  canBrowse: true,
  obs: {
    A: { url: 'ws://127.0.0.1:4455', hasPassword: true, pending: false },
    B: { url: 'ws://127.0.0.1:4456', hasPassword: false, pending: false },
  },
  sceneRoles: { A: { LIVE: 'Direct', TALK: 'Plan large' }, B: {} },
  displayPort: 7788,
  recordingRoot: null,
  fileSlug: null,
  relaySourceRoomId: null,
  openFeedbackProjectId: null,
  promptRecordingOnStart: true,
  promptRecordingOnStop: true,
  sceneOnStart: 'LIVE',
}

interface Send {
  body: unknown
}

let calls: Send[]
let refuse: boolean
/** What the machine answers, when the gesture brings something back. */
let answer: { ok: boolean; detail?: unknown } | null

function room(overrides: Partial<VisibleConfig> = {}) {
  const view = payload()
  view.diagnostics!.config = { ...CONFIG, ...overrides }
  useRoomStore().seed(view)
  return view
}

beforeEach(() => {
  setActivePinia(createPinia())
  calls = []
  refuse = false
  answer = null
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)) })
    const body = answer ?? { ok: !refuse, message: refuse ? 'Refusé' : 'Fait' }
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    })
  })
})

describe('draft', () => {
  it('populates on opening, not on every state received', () => {
    room()
    const config = useConfigStore()
    config.show()

    config.draft!.fileSlug = 'track-1'
    // A new state arrives: the control app gets one every few
    // secondes, et repeupler effacerait la saisie en cours.
    useRoomStore().payload!.diagnostics!.config = { ...CONFIG, fileSlug: 'other' }

    expect(config.draft?.fileSlug).toBe('track-1')
  })

  it('offers nothing to configure while the hub has not answered', () => {
    const view = payload()
    view.diagnostics!.config = null
    useRoomStore().seed(view)
    const config = useConfigStore()

    config.show()

    // An empty form would fill itself with zeros and send them.
    expect(config.draft).toBe(null)
    expect(config.patch()).toBe(null)
  })
})

describe('what the form sends', () => {
  it('does not send back a password it never had', () => {
    room()
    const config = useConfigStore()
    config.show()

    const patch = config.patch() as { obs: { A: Record<string, unknown> } }

    // An empty field means "unchanged": the page never had the password, so it
    // cannot send it back in order to keep it.
    expect(patch.obs.A).toEqual({ url: 'ws://127.0.0.1:4455' })
  })

  it('can remove a password, which an empty field does not say', () => {
    room()
    const config = useConfigStore()
    config.show()
    config.draft!.obs.A.clearPassword = true

    expect((config.patch() as { obs: { A: { password: unknown } } }).obs.A.password).toBe(null)
  })

  it('keeps a role mapped outside the three offered for the instance', () => {
    room()
    const config = useConfigStore()
    config.show()
    config.draft!.sceneRoles.A.LIVE = 'Antenne'

    /*
     * `TALK` on OBS-A: the three roles offered per instance are a convention of the
     * form, not a constraint of the model — the map accepts any of the six on either
     * side. The draft starts from what exists, otherwise opening the modal and
     * saving would be enough to lose a setting nobody touched.
     */
    const patch = config.patch() as { sceneRoles: { A: Record<string, string> } }
    expect(patch.sceneRoles.A).toEqual({ LIVE: 'Antenne', TALK: 'Plan large' })
  })

  it('clears a role set back to "non configuré"', () => {
    room()
    const config = useConfigStore()
    config.show()
    config.draft!.sceneRoles.A.LIVE = ''

    expect((config.patch() as { sceneRoles: { A: Record<string, string> } }).sceneRoles.A).toEqual({
      TALK: 'Plan large',
    })
  })

  it('falls back on the existing port rather than on zero', () => {
    room()
    const config = useConfigStore()
    config.show()
    config.draft!.displayPort = 'seven-thousand'

    // `Number('seven-thousand')` is NaN: sending it would cut the local screen at the
    // next start-up, with nothing on screen to say why.
    expect((config.patch() as { displayPort: number }).displayPort).toBe(7788)
  })

  it('returns null for text fields left empty', () => {
    room({ fileSlug: 'track-1', recordingRoot: '/rushes' })
    const config = useConfigStore()
    config.show()
    config.draft!.fileSlug = '   '
    config.draft!.recordingRoot = ''

    const patch = config.patch() as { fileSlug: unknown; recordingRoot: unknown }
    expect(patch.fileSlug).toBe(null)
    expect(patch.recordingRoot).toBe(null)
  })
})

describe('saving', () => {
  it('repopulates from what the hub kept, not from what was typed', async () => {
    room()
    const config = useConfigStore()
    config.show()
    config.draft!.fileSlug = 'saisi'

    await config.save()
    await flushPromises()

    // It is the only way to see what was really kept: the hub normalises, and a
    // refused field would stay on screen as if it had held.
    expect(config.draft?.fileSlug).toBe('')
    expect(config.notice).toEqual({ text: 'Enregistré.', tone: 'ok' })
  })

  it('keeps what was typed when the hub refuses', async () => {
    room()
    const config = useConfigStore()
    config.show()
    config.draft!.fileSlug = 'saisi'
    refuse = true

    await config.save()

    expect(config.draft?.fileSlug).toBe('saisi')
    expect(config.notice).toEqual({ text: 'Refusé', tone: 'alert' })
  })

  it('saves before connecting, so as not to plug in the wrong address', async () => {
    room()
    const config = useConfigStore()
    config.show()

    await config.connect('A')

    // Plugging into the old address while the new one is on screen would give a
    // successful connection to the wrong OBS, and nothing to say so.
    expect(calls.map((call) => (call.body as { action: string }).action)).toEqual([
      'room.configure',
      'obs.connect',
    ])
  })

  it('does not connect if the save fails', async () => {
    room()
    const config = useConfigStore()
    config.show()
    refuse = true

    await config.connect('A')

    expect(calls.map((call) => (call.body as { action: string }).action)).toEqual([
      'room.configure',
    ])
  })

  it('connects all the same offline, without going through the hub', async () => {
    const view = room()
    view.state.connectivity = 'OFFLINE'
    const config = useConfigStore()
    config.show()

    await config.connect('A')

    // The configuration is saved on the hub; plugging into OBS is not — that is a
    // local gesture, and it is precisely when the hub is missing that it is needed.
    expect(calls.map((call) => (call.body as { action: string }).action)).toEqual(['obs.connect'])
  })
})

describe('OBS block', () => {
  function block(obs: Partial<ObsState>, config: VisibleConfig = CONFIG) {
    room()
    const store = useConfigStore()
    store.show()
    return mount(ObsConfigBlock, {
      props: {
        instance: 'A',
        title: 'OBS-A — projection',
        draft: store.draft!,
        config,
        obs: obsState(obs),
      },
    })
  }

  it('forbids reconnecting under a running take', () => {
    const wrapper = block({ connected: true, recording: true, scenes: [], currentSceneName: 'X' })

    // Reconnecter, c'est couper.
    expect(wrapper.get('[data-connect="A"]').attributes('disabled')).toBeDefined()
  })

  it('lets a disconnected instance that said "recording" be reconnected', () => {
    // Its last known state is precisely the stale one.
    const wrapper = block({ connected: false, recording: true, scenes: [] })
    expect(wrapper.get('[data-connect="A"]').attributes('disabled')).toBeUndefined()
  })

  it('says a saved setting is not yet plugged in', () => {
    const wrapper = block({ connected: true, recording: false, scenes: [], currentSceneName: 'X' }, {
      ...CONFIG,
      obs: { ...CONFIG.obs, A: { ...CONFIG.obs.A, pending: true } },
    })

    // Without saying so, a correct setting would stay without effect with nobody
    // seeing why: saving does not reconnect.
    expect(wrapper.get('[data-state="A"]').text()).toContain('réglages non appliqués')
  })

  it('keeps in the list a scene OBS does not know, named for what it is', () => {
    const wrapper = block({ connected: true, recording: false, scenes: ['Autre'] })

    // That is in fact the defect being repaired here: clearing it by opening the
    // modal would make the offending setting disappear without showing it.
    expect(wrapper.get('#cfg-role-A-LIVE').text()).toContain("Direct — absente d'OBS")
  })
})

describe('capture mode', () => {
  function capture(url = 'ws://127.0.0.1:4456') {
    room({ obs: { ...CONFIG.obs, B: { ...CONFIG.obs.B, url } } })
    const store = useConfigStore()
    store.show()
    return {
      store,
      wrapper: mount(ObsConfigBlock, {
        props: {
          instance: 'B',
          title: 'OBS-B — captation',
          draft: store.draft!,
          config: store.config!,
          obs: obsState({ connected: false, scenes: [] }),
        },
      }),
    }
  }

  it('writes the plugin setup by emptying the address', async () => {
    const { store, wrapper } = capture()

    await wrapper.get('[data-mode="canvas"]').trigger('click')

    // The truth stays the address: empty means "no OBS-B, the capture rides in
    // OBS-A's vertical canvas". The switch is the gesture that writes it.
    expect(store.draft!.obs.B.url).toBe('')
    expect(wrapper.find('#cfg-url-B').exists()).toBe(false)
  })

  it('gives back the address when the second OBS is chosen again', async () => {
    const { store, wrapper } = capture()

    await wrapper.get('[data-mode="canvas"]').trigger('click')
    await wrapper.get('[data-mode="obs-b"]').trigger('click')

    // Switching modes is how one compares two setups; the round trip must not cost
    // the address of an OBS-B that is still plugged in.
    expect(store.draft!.obs.B.url).toBe('ws://127.0.0.1:4456')
    expect(wrapper.find('#cfg-url-B').exists()).toBe(true)
  })

  it('opens on the plugin when that is what is saved', () => {
    const { wrapper } = capture('')

    expect(wrapper.get('[data-mode="canvas"]').attributes('data-active')).toBe('true')
  })

  it('offers no such choice to the projection', () => {
    room()
    const store = useConfigStore()
    store.show()
    store.draft!.obs.A.url = ''
    const wrapper = mount(ObsConfigBlock, {
      props: {
        instance: 'A',
        title: 'OBS-A — projection',
        draft: store.draft!,
        config: store.config!,
        obs: obsState({ connected: false, scenes: [] }),
      },
    })

    // An OBS-A without an address is a missing setting, not a second setup: the
    // field must stay, precisely to be filled in.
    expect(wrapper.find('[data-mode="canvas"]').exists()).toBe(false)
    expect(wrapper.find('#cfg-url-A').exists()).toBe(true)
  })
})

describe('screens menu', () => {
  it('adds the public wall only when the room knows its address', async () => {
    const withoutWall = mount(ScreensMenu, { props: { payload: payload() } })
    await withoutWall.get('[data-role="btn-screens"]').trigger('click')
    expect(withoutWall.text()).not.toContain('Mur public')

    const withWall = mount(ScreensMenu, {
      props: { payload: payload({ wall: { url: 'https://mur.example', qrSvg: '' } }) },
    })
    await withWall.get('[data-role="btn-screens"]').trigger('click')

    // A dead link in this list would send people looking for a network failure
    // where there is only a missing setting.
    expect(withWall.text()).toContain('https://mur.example')
  })

  it('opens each screen in another tab', async () => {
    const wrapper = mount(ScreensMenu, { props: { payload: payload() } })
    await wrapper.get('[data-role="btn-screens"]').trigger('click')

    // Opening the projection in the control window would replace the commands with
    // the room screen, in the middle of an intervention.
    for (const link of wrapper.findAll('a')) expect(link.attributes('target')).toBe('_blank')
  })

  it('copies the whole address, not the path it lists', async () => {
    const written: string[] = []
    stubClipboard(async (text) => void written.push(text))

    const wrapper = mount(ScreensMenu, { props: { payload: payload() } })
    await wrapper.get('[data-role="btn-screens"]').trigger('click')
    await wrapper.get('[data-role="btn-copy-/display/overlay"]').trigger('click')
    await flushPromises()

    // An OBS Browser Source resolves nothing: pasting `/display/overlay` there
    // gives a source that never loads.
    expect(written).toEqual([`${globalThis.location.origin}/display/overlay`])
    expect(wrapper.get('[data-role="btn-copy-/display/overlay"]').text()).toBe('Copié')
  })

  it('leaves the menu open, the next source being set right after', async () => {
    stubClipboard(async () => {})

    const wrapper = mount(ScreensMenu, { props: { payload: payload() } })
    await wrapper.get('[data-role="btn-screens"]').trigger('click')
    await wrapper.get('[data-role="btn-copy-/display/overlay"]').trigger('click')
    await flushPromises()

    // The three capture sources are set one after the other; reopening the menu
    // between each is a gesture nothing justifies.
    expect(wrapper.find('[data-role="screens-list"]').exists()).toBe(true)
  })

  it('falls back to the old copy where there is no clipboard', async () => {
    // No clipboard at all: what the page gets as soon as it is read over the
    // network, at an address which is not `127.0.0.1`.
    stubClipboard(null)
    stubExecCommand(() => true)

    const wrapper = mount(ScreensMenu, { props: { payload: payload() } })
    await wrapper.get('[data-role="btn-screens"]').trigger('click')
    await wrapper.get('[data-role="btn-copy-/display/overlay"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-role="btn-copy-/display/overlay"]').text()).toBe('Copié')
  })

  it('says so when nothing could be copied', async () => {
    stubClipboard(null)
    stubExecCommand(() => false)

    const wrapper = mount(ScreensMenu, { props: { payload: payload() } })
    await wrapper.get('[data-role="btn-screens"]').trigger('click')
    await wrapper.get('[data-role="btn-copy-/display/overlay"]').trigger('click')
    await flushPromises()

    // A button that answered "Copié" over an empty clipboard would be found out
    // in front of OBS, with nothing to paste and no idea why.
    expect(wrapper.get('[data-role="btn-copy-/display/overlay"]').text()).toBe('Échec')
  })
})

/**
 * The clipboard, which the test DOM does not provide.
 *
 * `null` puts the page back in the case it meets over the network: only
 * `127.0.0.1` counts as a trusted origin, and everywhere else
 * `navigator.clipboard` is simply absent.
 */
function stubClipboard(writeText: ((text: string) => Promise<void>) | null): void {
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: writeText == null ? undefined : { writeText },
    configurable: true,
    writable: true,
  })
}

/** `execCommand` is not implemented either, and it is the fallback being tested. */
function stubExecCommand(answer: () => boolean): void {
  Object.defineProperty(document, 'execCommand', {
    value: answer,
    configurable: true,
    writable: true,
  })
}

/**
 * The VOD folder, chosen rather than retyped.
 *
 * A disk path can only be typed by hand without error when one has it in front of
 * them — and it is precisely the **room machine**'s disk it names, not the disk of
 * wherever the page is being read.
 */
describe('choosing the VOD folder', () => {
  function openPanel(overrides: Partial<VisibleConfig> = {}) {
    room(overrides)
    const config = useConfigStore()
    config.show()
    return config
  }

  it('fills the field with what the machine chose', async () => {
    answer = { ok: true, detail: 'D:\\captations\\2026' }
    const config = openPanel()

    await config.browse()

    expect(calls.at(-1)?.body).toEqual({ action: 'config.chooseFolder' })
    expect(config.draft?.recordingRoot).toBe('D:\\captations\\2026')
  })

  it('n’enregistre rien au passage', async () => {
    answer = { ok: true, detail: 'D:\\captations\\2026' }
    const config = openPanel()

    await config.browse()

    /*
     * "Enregistrer" is what decides, as for the rest of the panel. A picker that
     * wrote straight away would turn a glance at the directory tree into a change to
     * the room.
     */
    expect(calls.map((call) => (call.body as { action: string }).action)).toEqual([
      'config.chooseFolder',
    ])
  })

  it('leaves the field as it was when one gives up', async () => {
    // Closing a picker is a gesture, not a failure.
    answer = { ok: true, detail: null }
    const config = openPanel({ recordingRoot: 'D:\\déjà\\là' })

    await config.browse()

    expect(config.draft?.recordingRoot).toBe('D:\\déjà\\là')
  })

  it('does not offer the gesture when the machine cannot open it', () => {
    /*
     * `dev:headless`, or the control app opened from a browser: there is no picker
     * to open. A button that does not answer is worth less than a field to fill in
     * by hand — the modal hides it on that value.
     */
    expect(openPanel({ canBrowse: false }).canBrowse).toBe(false)
    expect(openPanel({ canBrowse: true }).canBrowse).toBe(true)
  })
})

/**
 * What is missing before the room can be driven, and the panel that opens to say
 * so.
 *
 * The verdict is taken without waiting: setting a room up happens before the first
 * talk, not during it, and a badly configured room must say so while somebody is
 * still in front of the screen. What repairs itself — the machine reconnects OBS
 * every three seconds — clears from the list, with the panel open, without closing
 * it under the fingers.
 */
describe('incomplete room at start-up', () => {
  /** A configured, plugged-in room: the starting point, damaged field by field. */
  function configuredRoom(
    overrides: Partial<VisibleConfig> = {},
    obs: { A?: ObsState | null; B?: ObsState | null } = {},
  ) {
    const view = payload()
    view.diagnostics!.config = {
      ...CONFIG,
      recordingRoot: 'D:\\captations',
      sceneRoles: { A: { LIVE: 'Direct' }, B: {} },
      ...overrides,
    }
    view.diagnostics!.obs = {
      A: obs.A === undefined ? obsState({ instance: 'A' }) : obs.A,
      B: obs.B === undefined ? obsState({ instance: 'B' }) : obs.B,
    }
    useRoomStore().seed(view)
    return useConfigStore()
  }

  const codes = (config: ReturnType<typeof useConfigStore>) =>
    config.missing.map((entry) => entry.code)

  it('reproaches nothing to a configured, plugged-in room', () => {
    expect(configuredRoom().missing).toEqual([])
  })

  it('names the two missing OBS instances and the VOD folder', () => {
    const config = configuredRoom({ recordingRoot: null }, { A: null, B: obsState({ connected: false }) })

    expect(codes(config)).toEqual(['obs-A', 'obs-B', 'vod'])
  })

  it('says the missing address rather than the disconnection', () => {
    // "Not connected" on an instance whose address is empty would send people
    // looking at the network.
    const config = configuredRoom(
      { obs: { A: { url: '', hasPassword: false, pending: false }, B: CONFIG.obs.B } },
      { A: null },
    )

    expect(codes(config)).toContain('obs-A-url')
    expect(codes(config)).not.toContain('obs-A')
  })

  it('reports a role that is configured but not found in OBS', () => {
    const config = configuredRoom({}, { B: obsState({ unresolvedRoles: ['TALK'] }) })

    expect(config.missing).toEqual([
      { code: 'roles-B', text: 'Rôles introuvables dans OBS-B : TALK.' },
    ])
  })

  it('does not reproach the take for having no role mapped', () => {
    // Many rooms never change shot during a talk: that would be a false reason.
    // Projection with no role, on the other hand, has no button.
    expect(configuredRoom({ sceneRoles: { A: { LIVE: 'Direct' }, B: {} } }).missing).toEqual([])
    expect(codes(configuredRoom({ sceneRoles: { A: {}, B: {} } }))).toEqual(['scenes-A'])
  })

  it('opens the panel without waiting on an incomplete room', () => {
    const config = configuredRoom({ recordingRoot: null }, { B: obsState({ connected: false }) })

    config.checkAtStartup()

    expect(config.open).toBe(true)
    // The banner says why: a panel that opens on its own reads as a slip until it
    // has given its reason.
    expect(config.openAtStartup).toBe(true)
    expect(codes(config)).toEqual(['obs-B', 'vod'])
  })

  it('opens nothing on a configured, plugged-in room', () => {
    const config = configuredRoom()

    config.checkAtStartup()

    expect(config.open).toBe(false)
  })

  it('clears from the list what the machine repairs by itself', () => {
    // OBS is often started after the control app and the machine retries endlessly.
    // The row goes away by itself, without the panel closing under the fingers.
    const config = configuredRoom({}, { B: obsState({ connected: false }) })
    config.checkAtStartup()
    expect(codes(config)).toEqual(['obs-B'])

    configuredRoom()

    expect(config.missing).toEqual([])
    expect(config.open).toBe(true)
  })

  it('does not reopen the panel the operator has just closed', () => {
    const config = configuredRoom({ recordingRoot: null })
    config.checkAtStartup()
    expect(config.open).toBe(true)

    config.open = false
    // A room with no VOD folder stays drivable for everything else: a panel that
    // reopens is no longer a reminder, it is an obstacle.
    config.checkAtStartup()

    expect(config.open).toBe(false)
  })

  it('judges as soon as the hub finally returns the configuration', async () => {
    const view = payload()
    view.diagnostics!.config = null
    useRoomStore().seed(view)
    const config = useConfigStore()

    config.checkAtStartup()
    // A room nothing is known about is not a badly configured room.
    expect(config.open).toBe(false)

    configuredRoom({ recordingRoot: null })
    await nextTick()

    expect(config.open).toBe(true)
  })

  it('does not present a hand-opened panel as a reminder', () => {
    const config = configuredRoom()
    config.show()
    expect(config.openAtStartup).toBe(false)
  })
})

/**
 * Disconnecting the machine, from the configuration.
 *
 * The gesture exists because the alternative was going to delete a file in
 * `%APPDATA%` — on a machine in a room, the morning of an event. It is offered
 * on that machine's own screen only: driven from a phone, the same page would
 * take a room off the air until somebody walks to the console.
 */
describe('unpairing a machine', () => {
  /** Reka portals the panel out of the component: the document is what we read. */
  const mountDialog = () => mount(ConfigDialog, { props: { payload: payload() }, attachTo: document.body })

  /**
   * Waits for what the portal renders, rather than for a fixed number of ticks.
   *
   * A single `flushPromises` was enough on an idle machine and not while the rest
   * of the suite ran beside it: the test failed about one run in three, which is
   * worse than a test that fails.
   */
  const until = async (find: () => Element | null | undefined): Promise<Element> => {
    for (let i = 0; i < 50; i += 1) {
      const found = find()
      if (found != null) return found
      await flushPromises()
    }
    throw new Error('rien trouvé dans le document après cinquante tours')
  }
  /**
   * Scoped to the confirmation itself: the button that opens it says
   * «&nbsp;Déconnecter ce poste&nbsp;», and any looser search finds that one first.
   */
  const button = (label: string) =>
    [...document.querySelectorAll('[role="alertdialog"] button')].find((node) =>
      node.textContent?.includes(label),
    )

  // The panel is portalled into the body and outlives the wrapper: left there, the
  // next test would find the previous one's button and believe it.
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('offers the button on the machine, and confirms before acting', async () => {
    room()
    const config = useConfigStore()
    config.show()
    const sent: unknown[] = []
    vi.spyOn(useActionsStore(), 'act').mockImplementation(async (action) => {
      sent.push(action)
      return { ok: true }
    })

    const wrapper = mountDialog()
    await flushPromises()

    const open = await until(() => document.querySelector('#btn-unpair'))
    open.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    // Asked, not done: the room leaves the air, and the way back is in front of
    // the machine.
    expect(sent).toEqual([])

    const confirm = await until(() => button('Déconnecter'))
    confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(sent).toEqual([{ action: 'pairing.forget' }])
    // The panel closes with it: what it configures is about to ask for a code.
    expect(config.open).toBe(false)
    wrapper.unmount()
  })

  it('opens the command diagnostic, and confirms before taking the stream again', async () => {
    const view = room()
    view.diagnostics!.commands = { lastApplied: 412, applied: 37, hubLast: 12 }
    useRoomStore().seed(view)
    useConfigStore().show()
    const sent: unknown[] = []
    vi.spyOn(useActionsStore(), 'act').mockImplementation(async (action) => {
      sent.push(action)
      return { ok: true }
    })

    const wrapper = mount(ConfigDialog, { props: { payload: view }, attachTo: document.body })
    const open = await until(() => document.querySelector('#btn-commands-diagnostic'))
    open.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    // The room waits past what the hub issued: said as such, not left to the numbers.
    const verdict = await until(() => document.querySelector('[data-role="commands-verdict"]'))
    expect(verdict.textContent).toContain('Désaligné')
    expect(document.querySelector('[data-role="commands-last-applied"]')?.textContent).toContain('#412')

    const ask = await until(() => document.querySelector('[data-action="commands.forget"]'))
    ask.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(sent).toEqual([])

    const confirm = await until(() => button('Reprendre'))
    confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(sent).toEqual([{ action: 'commands.forget' }])
    wrapper.unmount()
  })

  it('does not offer it to a control app served remotely', async () => {
    // The boot scope only: `start` would also open a session against a hub that
    // does not exist here, and its refusal would land in whichever test runs next.
    vi.spyOn(useSessionStore(), 'start').mockImplementation(() => {})
    useGatewayStore().start({ portee: 'distante', roomId: 'track-1', salles: [], google: null, version: null })
    room()
    useConfigStore().show()

    const wrapper = mountDialog()
    // The panel is there — so its absent button is an absence, not a slow render.
    await until(() => document.querySelector('#cfg-port'))

    expect(document.querySelector('#btn-unpair')).toBeNull()
    expect(document.querySelector('#btn-commands-diagnostic')).toBeNull()
    wrapper.unmount()
  })
})
