import type { VisibleConfig, ObsState } from '@cloudnord/contract'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ObsConfigBlock from '../src/components/ObsConfigBlock.vue'
import ScreensMenu from '../src/components/ScreensMenu.vue'
import { useConfigStore } from '../src/stores/config.js'
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

interface Envoi {
  body: unknown
}

let calls: Envoi[]
let refuse: boolean
/** What the machine answers, when the gesture brings something back. */
let answer: { ok: boolean; detail?: unknown } | null

function salle(overrides: Partial<VisibleConfig> = {}) {
  const etat = payload()
  etat.diagnostics!.config = { ...CONFIG, ...overrides }
  useRoomStore().seed(etat)
  return etat
}

beforeEach(() => {
  setActivePinia(createPinia())
  calls = []
  refuse = false
  answer = null
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)) })
    const corps = answer ?? { ok: !refuse, message: refuse ? 'Refusé' : 'Fait' }
    return new Response(JSON.stringify(corps), {
      headers: { 'content-type': 'application/json' },
    })
  })
})

describe('draft', () => {
  it('populates on opening, not on every state received', () => {
    salle()
    const config = useConfigStore()
    config.show()

    config.draft!.fileSlug = 'track-1'
    // A new state arrives: the control app gets one every few
    // secondes, et repeupler effacerait la saisie en cours.
    useRoomStore().payload!.diagnostics!.config = { ...CONFIG, fileSlug: 'other' }

    expect(config.draft?.fileSlug).toBe('track-1')
  })

  it('offers nothing to configure while the hub has not answered', () => {
    const etat = payload()
    etat.diagnostics!.config = null
    useRoomStore().seed(etat)
    const config = useConfigStore()

    config.show()

    // An empty form would fill itself with zeros and send them.
    expect(config.draft).toBe(null)
    expect(config.patch()).toBe(null)
  })
})

describe('what the form sends', () => {
  it('ne renvoie pas un mot de passe qu’il n’a jamais eu', () => {
    salle()
    const config = useConfigStore()
    config.show()

    const patch = config.patch() as { obs: { A: Record<string, unknown> } }

    // An empty field means "unchanged": the page never had the password,
    // elle ne peut pas le renvoyer pour le conserver.
    expect(patch.obs.A).toEqual({ url: 'ws://127.0.0.1:4455' })
  })

  it('sait retirer un mot de passe, ce qu’un champ vide ne dit pas', () => {
    salle()
    const config = useConfigStore()
    config.show()
    config.draft!.obs.A.clearPassword = true

    expect((config.patch() as { obs: { A: { password: unknown } } }).obs.A.password).toBe(null)
  })

  it('keeps a role mapped outside the three offered for the instance', () => {
    salle()
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
    salle()
    const config = useConfigStore()
    config.show()
    config.draft!.sceneRoles.A.LIVE = ''

    expect((config.patch() as { sceneRoles: { A: Record<string, string> } }).sceneRoles.A).toEqual({
      TALK: 'Plan large',
    })
  })

  it('falls back on the existing port rather than on zero', () => {
    salle()
    const config = useConfigStore()
    config.show()
    config.draft!.displayPort = 'sept-mille'

    // `Number('sept-mille')` is NaN: sending it would cut the local screen at the
    // next start-up, with nothing on screen to say why.
    expect((config.patch() as { displayPort: number }).displayPort).toBe(7788)
  })

  it('returns null for text fields left empty', () => {
    salle({ fileSlug: 'track-1', recordingRoot: '/rushes' })
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
    salle()
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

  it('garde la saisie quand le hub refuse', async () => {
    salle()
    const config = useConfigStore()
    config.show()
    config.draft!.fileSlug = 'saisi'
    refuse = true

    await config.save()

    expect(config.draft?.fileSlug).toBe('saisi')
    expect(config.notice).toEqual({ text: 'Refusé', tone: 'alert' })
  })

  it('enregistre avant de connecter, pour ne pas brancher la mauvaise adresse', async () => {
    salle()
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
    salle()
    const config = useConfigStore()
    config.show()
    refuse = true

    await config.connect('A')

    expect(calls.map((call) => (call.body as { action: string }).action)).toEqual([
      'room.configure',
    ])
  })

  it('connects all the same offline, without going through the hub', async () => {
    const etat = salle()
    etat.state.connectivity = 'OFFLINE'
    const config = useConfigStore()
    config.show()

    await config.connect('A')

    // La configuration s'enregistre sur le hub ; brancher OBS, non — c'est un
    // geste local, et c'est justement quand le hub manque qu'on en a besoin.
    expect(calls.map((call) => (call.body as { action: string }).action)).toEqual(['obs.connect'])
  })
})

describe('OBS block', () => {
  function bloc(obs: Partial<ObsState>, config: VisibleConfig = CONFIG) {
    salle()
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

  it('interdit de reconnecter sous une prise en cours', () => {
    const wrapper = bloc({ connected: true, recording: true, scenes: [], currentSceneName: 'X' })

    // Reconnecter, c'est couper.
    expect(wrapper.get('[data-connect="A"]').attributes('disabled')).toBeDefined()
  })

  it('lets a disconnected instance that said "recording" be reconnected', () => {
    // Its last known state is precisely the stale one.
    const wrapper = bloc({ connected: false, recording: true, scenes: [] })
    expect(wrapper.get('[data-connect="A"]').attributes('disabled')).toBeUndefined()
  })

  it('says a saved setting is not yet plugged in', () => {
    const wrapper = bloc({ connected: true, recording: false, scenes: [], currentSceneName: 'X' }, {
      ...CONFIG,
      obs: { ...CONFIG.obs, A: { ...CONFIG.obs.A, pending: true } },
    })

    // Without saying so, a correct setting would stay without effect with nobody
    // voie pourquoi : enregistrer ne reconnecte pas.
    expect(wrapper.get('[data-state="A"]').text()).toContain('réglages non appliqués')
  })

  it('keeps in the list a scene OBS does not know, named for what it is', () => {
    const wrapper = bloc({ connected: true, recording: false, scenes: ['Autre'] })

    // That is in fact the defect being repaired here: clearing it by opening the
    // modal would make the offending setting disappear without showing it.
    expect(wrapper.get('#cfg-role-A-LIVE').text()).toContain("Direct — absente d'OBS")
  })
})

describe('screens menu', () => {
  it('adds the public wall only when the room knows its address', async () => {
    const sans = mount(ScreensMenu, { props: { payload: payload() } })
    await sans.get('[data-role="btn-screens"]').trigger('click')
    expect(sans.text()).not.toContain('Mur public')

    const avec = mount(ScreensMenu, {
      props: { payload: payload({ wall: { url: 'https://mur.example', qrSvg: '' } }) },
    })
    await avec.get('[data-role="btn-screens"]').trigger('click')

    // A dead link in this list would send people looking for a network failure
    // where there is only a missing setting.
    expect(avec.text()).toContain('https://mur.example')
  })

  it('opens each screen in another tab', async () => {
    const wrapper = mount(ScreensMenu, { props: { payload: payload() } })
    await wrapper.get('[data-role="btn-screens"]').trigger('click')

    // Opening the projection in the control window would replace the commands with
    // the room screen, in the middle of an intervention.
    for (const lien of wrapper.findAll('a')) expect(lien.attributes('target')).toBe('_blank')
  })
})

/**
 * The VOD folder, chosen rather than retyped.
 *
 * A disk path can only be typed by hand without error when one has it in front of
 * them — and it is precisely the **room machine**'s disk it names, not the disk of
 * wherever the page is being read.
 */
describe('choosing the VOD folder', () => {
  function openPanel(overrides: Partial<VisibleConfig> = {}) {
    salle(overrides)
    const config = useConfigStore()
    config.show()
    return config
  }

  it('remplit le champ avec ce que le poste a choisi', async () => {
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
    const etat = payload()
    etat.diagnostics!.config = {
      ...CONFIG,
      recordingRoot: 'D:\\captations',
      sceneRoles: { A: { LIVE: 'Direct' }, B: {} },
      ...overrides,
    }
    etat.diagnostics!.obs = {
      A: obs.A === undefined ? obsState({ instance: 'A' }) : obs.A,
      B: obs.B === undefined ? obsState({ instance: 'B' }) : obs.B,
    }
    useRoomStore().seed(etat)
    return useConfigStore()
  }

  const codes = (config: ReturnType<typeof useConfigStore>) =>
    config.missing.map((entry) => entry.code)

  it('reproaches nothing to a configured, plugged-in room', () => {
    expect(configuredRoom().missing).toEqual([])
  })

  it('nomme les deux OBS absents et le dossier des VOD', () => {
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
    // Beaucoup de salles ne changent jamais de plan pendant un talk : ce serait
    // a false reason. Projection with no role, on the other hand, has no button.
    expect(configuredRoom({ sceneRoles: { A: { LIVE: 'Direct' }, B: {} } }).missing).toEqual([])
    expect(codes(configuredRoom({ sceneRoles: { A: {}, B: {} } }))).toEqual(['scenes-A'])
  })

  it('opens the panel without waiting on an incomplete room', () => {
    const config = configuredRoom({ recordingRoot: null }, { B: obsState({ connected: false }) })

    config.checkAtStartup()

    expect(config.open).toBe(true)
    // Le bandeau dit pourquoi : un panneau qui s'ouvre tout seul se lit comme
    // a slip until it has given its reason.
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
    // Une salle sans dossier de VOD reste pilotable pour tout le reste : un
    // panneau qui se rouvre n'est plus un rappel, c'est un obstacle.
    config.checkAtStartup()

    expect(config.open).toBe(false)
  })

  it('judges as soon as the hub finally returns the configuration', async () => {
    const etat = payload()
    etat.diagnostics!.config = null
    useRoomStore().seed(etat)
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
