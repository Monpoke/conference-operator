import type { ControlCommand, ControlRoom, ControlView } from '@cloudnord/contract'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App.vue'
import RoomSelect from '../src/components/RoomSelect.vue'
import LockBanner from '../src/components/LockBanner.vue'
import { payloadFromView } from '../src/lib/gateway.js'
import { useGatewayStore } from '../src/stores/gateway.js'
import { useRoomStore } from '../src/stores/room.js'
import { useSessionStore } from '../src/stores/session.js'
import { useLockStore } from '../src/stores/lock.js'
import { talk } from './fixtures.js'

/**
 * The mobile control app's three screens, in the order one crosses them.
 *
 * Sign in, choose a room, drive it — and each **replaces** the previous one: a
 * desk held in one hand has no room for two things at once. What this file holds
 * is what no typing says: that the right screen is mounted at the right moment,
 * and that nothing is driven until the room has been taken.
 */

const AT = Date.parse('2026-10-30T09:10:00.000Z')

function room(overrides: Partial<ControlRoom> = {}): ControlRoom {
  return {
    roomId: 'track-1',
    name: 'Track #1',
    conference: 'en-cours',
    connectivity: 'ONLINE',
    lock: null,
    ...overrides,
  }
}

/** The test's tab: the same one the store will build. */
const ME = 'session-of-this-test'
const OTHER_TAB = 'session-tablet'

function lockOf(holder: string, holderId = OTHER_TAB): ControlRoom['lock'] {
  return {
    roomId: 'track-1',
    holder,
    holderId,
    heldSince: new Date(AT - 12 * 60_000).toISOString(),
    lastSeenAt: new Date(AT).toISOString(),
    expiresAt: new Date(AT + 30_000).toISOString(),
  }
}

function vue(overrides: Partial<ControlView> = {}): ControlView {
  return {
    roomId: 'track-1',
    roomName: 'Track #1',
    event: { name: 'Cloud Nord 2026', shortName: 'Cloud Nord' },
    timezone: 'Europe/Paris',
    serverTime: new Date(AT).toISOString(),
    simulatedClock: false,
    connectivity: 'ONLINE',
    lastSeenAt: new Date(AT).toISOString(),
    conference: 'en-cours',
    targetSession: talk(),
    targetIsUpcoming: false,
    sessionStates: {},
    sessions: [talk()],
    sceneRole: 'HOLD',
    recording: false,
    streaming: false,
    displayMode: 'loop',
    sceneRoles: ['LIVE', 'HOLD'],
    relaySourceRoomId: null,
    promptRecordingOnStart: true,
    promptRecordingOnStop: true,
    sceneOnStart: 'LIVE',
    lock: null,
    ...overrides,
  }
}

/** The hub, reduced to what these screens ask of it. */
function fakeHub(rooms: ControlRoom[], viewOverrides: Partial<ControlView> = {}) {
  const calls: string[] = []
  /** What the room would receive. Kept apart from `calls`: a gesture, not a poll. */
  const commands: ControlCommand[] = []
  return {
    calls,
    commands,
    client: {
      rpc: {
        regie: {
          locks: async () => {
            calls.push('locks')
            return rooms
          },
          hold: async ({ force }: { force: boolean }) => {
            calls.push(force ? 'hold:force' : 'hold')
            return lockOf('regie@cloudnord.fr', ME)
          },
          release: async () => {
            calls.push('release')
            return { ok: true }
          },
          view: async () => vue(viewOverrides),
          command: async ({ action }: { action: ControlCommand }) => {
            commands.push(action)
            return { ok: true, applied: 'queued' as const }
          },
        },
      },
    } as never,
  }
}

function mountRemote(
  rooms: ControlRoom[],
  signedIn = true,
  viewOverrides: Partial<ControlView> = {},
) {
  const gateway = useGatewayStore()
  gateway.start({ portee: 'distante', roomId: null, salles: [], google: null })
  const session = useSessionStore()
  const hub = fakeHub(rooms, viewOverrides)
  session.client = hub.client
  session.signedIn = signedIn
  session.identity = 'regie@cloudnord.fr'
  return hub
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('EventSource', class {} as never)
  // The tab's identity: pinned so that "it is me" and "it is somebody else" are
  // decidable in a test.
  globalThis.sessionStorage.setItem('regie-session', ME)
  /*
   * With no token, the store asks the hub whether a cookie session is left — a real
   * call, and the only one of these screens that does not go through the oRPC
   * client. Answering "nobody" beats leaving it hanging: happy-dom aborts it on
   * teardown, and the trace looks like a failure.
   */
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }))
})

afterEach(() => {
  // The remote gateway polls every second: leaving it open would let a timer run
  // from one test file into the next.
  useGatewayStore().close()
})

describe('the three screens', () => {
  it('asks for the sign-in before anything else', () => {
    mountRemote([room()], false)
    const wrapper = mount(App)
    // No room list before signing in: the names are public, but their state and
    // their lock are not.
    expect(wrapper.find('#sign-in').exists()).toBe(true)
    expect(wrapper.find('[data-room="track-1"]').exists()).toBe(false)
  })

  it('offers the rooms before the hub has answered', async () => {
    const gateway = useGatewayStore()
    gateway.start({
      portee: 'distante',
      roomId: null,
      // The names are laid down in the shell: an empty list for the duration of a
      // round trip would read as a hub with no program.
      salles: [{ id: 'track-1', name: 'Track #1' }],
      google: null,
    })
    const session = useSessionStore()
    session.client = fakeHub([]).client
    session.signedIn = true

    const wrapper = mount(RoomSelect)
    expect(wrapper.text()).toContain('Track #1')
  })

  it('names who holds a room, and since when', async () => {
    mountRemote([room({ lock: lockOf('nuit@cloudnord.fr') })])
    const wrapper = mount(RoomSelect)
    await flushPromises()

    // "Occupée" on its own would send people looking for who, two rooms away.
    expect(wrapper.text()).toContain('nuit@cloudnord.fr')
  })

  it('enters without taking, even on a held room', async () => {
    const hub = mountRemote([room({ lock: lockOf('nuit@cloudnord.fr') })])
    const wrapper = mount(RoomSelect)
    await flushPromises()

    await wrapper.get('[data-room="track-1"]').trigger('click')
    await flushPromises()

    /*
     * A single decision, in a single place: the room's veil.
     *
     * Taking from the list forced a decision on the strength of one row, without
     * seeing what is happening in the room — when that is exactly what one wants to
     * look at before removing somebody's controls.
     */
    expect(hub.calls).not.toContain('hold')
    expect(hub.calls).not.toContain('hold:force')
    expect(useGatewayStore().roomId).toBe('track-1')
  })

  it('enters without taking a free room either', async () => {
    const hub = mountRemote([room()])
    const wrapper = mount(RoomSelect)
    await flushPromises()

    await wrapper.get('[data-room="track-1"]').trigger('click')
    await flushPromises()

    // The same path for both: a free room shows the "not held" veil, whose button
    // says "Prendre" and not "Reprendre".
    expect(hub.calls).not.toContain('hold')
    expect(useGatewayStore().roomId).toBe('track-1')
  })
})

/**
 * The lock veil: a state, and certainly not a button in a corner.
 *
 * What it holds is the property that was missing: when this tab is not driving,
 * **nothing the page shows is usable**. A small "Reprendre" in a bar left
 * "Commencer" and "Enregistrer" apparently active, each leaving only to be refused
 * by the hub — one presses first and reads afterwards, and it is in the middle of
 * a talk that one discovers why nothing happened.
 */
describe('the lock veil', () => {
  function inTheRoom(lock: ControlRoom['lock']) {
    const hub = mountRemote([room({ lock })])
    const gateway = useGatewayStore()
    gateway.roomId = 'track-1'
    gateway.currentLock = lock
    useRoomStore().seed(payloadFromView(vue({ lock }), Date.now()))
    return hub
  }

  it('lifts when somebody else holds the room', () => {
    inTheRoom(lockOf('nuit@cloudnord.fr'))
    const wrapper = mount(App)

    const veil = wrapper.get('[data-role="lock-veil"]')
    expect(veil.text()).toContain('pilotée par quelqu’un d’autre')
    expect(veil.text()).toContain('nuit@cloudnord.fr')
    expect(wrapper.get('[data-role="lock-take"]').text()).toBe('Reprendre le contrôle')
  })

  it('names the other tab rather than accuse oneself', () => {
    /*
     * The case that confused: the control app opened on the phone and then on the
     * tablet. One's own name shown as a third party's reads as a failure — one
     * looks for the second account, and it does not exist.
     */
    inTheRoom(lockOf('regie@cloudnord.fr', OTHER_TAB))
    const wrapper = mount(App)

    const veil = wrapper.get('[data-role="lock-veil"]')
    expect(veil.text()).toContain('Vous pilotez déjà cette salle ailleurs')
    expect(veil.get('[data-role="lock-veil-detail"]').text()).toContain('votre compte')
  })

  it('lifts too when nobody holds it any more', () => {
    // An expired hold — phone locked in a pocket, a tunnel — leaves the room free.
    // Nothing is broken, and the button does not say "Reprendre" over a room nobody
    // is holding.
    inTheRoom(null)
    const wrapper = mount(App)

    expect(wrapper.get('[data-role="lock-veil"]').text()).toContain('n’est pas prise')
    expect(wrapper.get('[data-role="lock-take"]').text()).toBe('Prendre le contrôle')
  })

  it('disappears as soon as this tab holds the room', () => {
    inTheRoom(lockOf('regie@cloudnord.fr', ME))
    const wrapper = mount(App)

    expect(wrapper.find('[data-role="lock-veil"]').exists()).toBe(false)
    // And the commands are there: it really is the same page underneath.
    expect(wrapper.find('#btn-talk-start').exists()).toBe(true)
  })

  it('takes over without asking again', async () => {
    const hub = inTheRoom(lockOf('nuit@cloudnord.fr'))
    const wrapper = mount(App)

    await wrapper.get('[data-role="lock-take"]').trigger('click')
    await flushPromises()

    // The veil *is* the question: asking it again in a modal would turn it into a
    // reflex click, and that is exactly what is being removed.
    expect(hub.calls).toContain('hold:force')
  })

  it('lets one go back to the room choice', async () => {
    const hub = inTheRoom(lockOf('nuit@cloudnord.fr'))
    const wrapper = mount(App)

    await wrapper.get('[data-role="lock-leave"]').trigger('click')
    await flushPromises()

    expect(useGatewayStore().roomId).toBeNull()
    // One does not release what one does not hold: the room's badge belongs to
    // son porteur.
    expect(hub.calls).not.toContain('release')
  })
})

/**
 * The room screen, driven from a phone.
 *
 * It goes through the downstream command flow, the very one that carries the scene
 * switches: nothing new links a phone to the room machine, and a command the room
 * misses is caught up on when it reconnects — or expires.
 *
 * What this block holds is the one thing no typing says: that the grid does not
 * offer modes whose content is chosen elsewhere, and that it describes the room
 * rather than the click.
 */
describe('the room screen', () => {
  function inTheRoom(viewOverrides: Partial<ControlView> = {}) {
    const lock = lockOf('regie@cloudnord.fr', ME)
    const hub = mountRemote([room({ lock })], true, viewOverrides)
    const gateway = useGatewayStore()
    gateway.roomId = 'track-1'
    gateway.currentLock = lock
    useRoomStore().seed(payloadFromView(vue({ lock, ...viewOverrides }), Date.now()))
    return hub
  }

  it('offers the modes the hub can hold, and not the other two', () => {
    inTheRoom()
    const wrapper = mount(App)
    const modes = wrapper
      .findAll('[data-command]')
      .map((button) => button.attributes('data-command'))

    expect(modes).toContain('loop')
    expect(modes).toContain('feedback')
    expect(modes).toContain('wall')
    /*
     * "Message" shows the banner typed in a panel that is not mounted here,
     * "Question choisie" the question picked in the room control app's moderation.
     * Offering them would give a button that takes over the room's screen to project
     * "Aucune question affichée" in front of the audience: the gesture would
     * succeed, and that is exactly what makes it bad.
     */
    expect(modes).not.toContain('message')
    expect(modes).not.toContain('question')
  })

  it('lights what the room displays, not what was asked for', async () => {
    const hub = inTheRoom({ displayMode: 'sponsors' })
    const wrapper = mount(App)

    expect(wrapper.get('[data-command="sponsors"]').classes().join(' ')).toContain('bg-brand')

    // The click posts, and stops there. The button will only move at the poll that
    // reports the switch — as in the room's control app, where it waits for OBS.
    await wrapper.get('[data-command="programme"]').trigger('click')
    await flushPromises()

    expect(hub.commands).toEqual([{ type: 'display.set', mode: 'programme' }])
    expect(wrapper.get('[data-command="sponsors"]').classes().join(' ')).toContain('bg-brand')
  })
})

describe('the lock banner', () => {
  function mountBanner(lock: ControlRoom['lock']) {
    const hub = mountRemote([room({ lock })])
    const gateway = useGatewayStore()
    gateway.roomId = 'track-1'
    gateway.currentLock = lock
    useRoomStore().seed(payloadFromView(vue({ lock }), Date.now()))
    return { hub, wrapper: mount(LockBanner, { props: { nowMs: AT } }) }
  }

  it('says one is driving, when this tab holds the room', () => {
    const { wrapper } = mountBanner(lockOf('regie@cloudnord.fr', ME))
    expect(wrapper.text()).toContain('Vous pilotez cette salle')
  })

  it('no longer carries a button to take over', () => {
    const { wrapper } = mountBanner(lockOf('nuit@cloudnord.fr'))

    // The decision lives in the veil. Here, a mention, so that the line does not
    // contradict it once the veil closes.
    expect(wrapper.get('[data-role="lock-holder"]').text()).toContain('Lecture seule')
    expect(wrapper.text()).not.toContain('Reprendre')
  })

  it('returns to the room choice, releasing what was held', async () => {
    const { hub, wrapper } = mountBanner(lockOf('regie@cloudnord.fr', ME))
    await wrapper.get('button').trigger('click')
    await flushPromises()

    // Hand it back on the way out: expiry would cover the case, but thirty seconds
    // of a blocked room while a colleague waits are visible.
    expect(hub.calls).toContain('release')
    expect(useGatewayStore().roomId).toBeNull()
  })
})
