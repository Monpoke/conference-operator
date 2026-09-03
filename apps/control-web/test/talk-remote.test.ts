import type { ControlCommand, ControlView } from '@cloudnord/contract'
import { useToast } from '@cloudnord/components'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { payloadFromView } from '../src/lib/gateway.js'
import { useTalkStore } from '../src/stores/talk.js'
import { useGatewayStore } from '../src/stores/gateway.js'
import { useRoomStore } from '../src/stores/room.js'
import { useSessionStore } from '../src/stores/session.js'
import { talk } from './fixtures.js'

/**
 * "Commencer"'s guards do not depend on the transport.
 *
 * `talk.ts` is a single path, in the room as on a phone: that is the whole point
 * of the gateway. This file checks that it stays so — and above all that the rule
 * that costs a VOD when it falls still holds on the other side: **if the recording
 * does not start, the talk does not begin.**
 *
 * That rule is the more fragile of the two sides, for a reason one cannot guess:
 * in the room, `recording.start` answers once OBS has answered; remotely, the hub
 * answers once it has queued the command. Taken as is, the guarantee disappeared
 * with nothing to say so.
 */

const AT = Date.parse('2026-10-30T08:59:00.000Z')

function view(overrides: Partial<ControlView> = {}): ControlView {
  return {
    roomId: 'track-1',
    roomName: 'Track #1',
    event: { name: 'Cloud Nord 2026', shortName: 'Cloud Nord' },
    timezone: 'Europe/Paris',
    serverTime: new Date(AT).toISOString(),
    simulatedClock: false,
    connectivity: 'ONLINE',
    lastSeenAt: new Date(AT).toISOString(),
    conference: 'pas-commencee',
    targetSession: talk(),
    targetIsUpcoming: true,
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

let commands: ControlCommand[]

/**
 * Mounts the control app in remote scope, on a given room.
 *
 * `views` is the queue the polling consumes: that is how "the room eventually
 * confirms" and "the room never confirms" are described.
 */
function remoteRoom(views: ControlView[]): void {
  commands = []
  const left = [...views]

  const gateway = useGatewayStore()
  gateway.start({ portee: 'distante', roomId: 'track-1', salles: [], google: null })

  const session = useSessionStore()
  session.client = {
    rpc: {
      regie: {
        view: async () => (left.length > 1 ? left.shift()! : left[0]!),
        command: async ({ action }: { action: ControlCommand }) => {
          commands.push(action)
          return { ok: true, applied: 'queued' as const }
        },
      },
    },
  } as never

  // The state the first poll would have laid down: the guards read it, and it is
  // exactly the payload the gateway synthesises for real.
  useRoomStore().seed(payloadFromView(views[0]!, Date.now()))

  /*
   * The clock is substituted, and the polling is not started.
   *
   * The confirmation by observation is bounded by a guard delay: exercising it in
   * real time would make the suite sleep five seconds for a rule that fits in three
   * lines. The gateway is built on the first gesture — exactly what happens for
   * real when a button is pressed before the stream is plugged in.
   */
  let clock = Date.now()
  gateway.configure({
    now: () => clock,
    wait: async (ms) => {
      clock += ms
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  useToast().clear()
  /*
   * With no token, the store asks the hub whether a cookie session is left — a real
   * call, and the only one of these screens that does not go through the oRPC
   * client. Answering "nobody" beats leaving it hanging: happy-dom aborts it on
   * teardown, and the trace looks like a failure.
   */
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }))
})

const types = (): string[] => commands.map((command) => command.type)

describe('starting, from a phone', () => {
  it('asks the same question about the recording as in the room', async () => {
    remoteRoom([view({ recording: false, promptRecordingOnStart: true })])
    const talk = useTalkStore()

    talk.askStart()
    await flushPromises()

    /*
     * The setting travels in the view. Without it the page would fall back on its
     * default and the question asked on a phone would not be the one asked in the
     * room — two operators, two different warnings.
     */
    expect(talk.recordingOpen).toBe(true)
    expect(types()).toEqual([])
  })

  it('stays silent when the room has unticked the warning', async () => {
    remoteRoom([view({ recording: false, promptRecordingOnStart: false })])
    const talk = useTalkStore()

    talk.askStart()
    await flushPromises()

    expect(talk.recordingOpen).toBe(false)
    // The lifecycle, then the scene: the switch follows the start, never the
    // reverse — a scene taken with no talk started would put the room on air over
    // nothing.
    expect(types()).toEqual(['session.start', 'scene.set'])
  })

  it('chains take, talk, then scene when the room confirms', async () => {
    remoteRoom([view({ recording: false }), view({ recording: true })])
    const talk = useTalkStore()

    await talk.launch(true)

    expect(types()).toEqual(['recording.set', 'session.start', 'scene.set'])
  })

  it('does not begin when the recording does not start', async () => {
    /*
     * The rule that costs a VOD when it falls.
     *
     * The room never confirms: the hub did queue the command — it answered 200 —
     * but nothing started. Beginning anyway would make the warning a lie the next
     * time round, and a missing VOD cannot be made good in the evening.
     */
    remoteRoom([view({ recording: false })])
    const talk = useTalkStore()

    await talk.launch(true)

    expect(types()).toEqual(['recording.set'])
    expect(useToast().notices.value.at(-1)?.text).toContain("n'a pas démarré")
  })

  it('switches no scene when the room chose not to switch', async () => {
    remoteRoom([view({ recording: true, sceneOnStart: null })])
    const talk = useTalkStore()

    await talk.launch(false)

    expect(types()).toEqual(['session.start'])
  })
})

describe('ending, from a phone', () => {
  it('confirms when early, and says what is left of the slot', async () => {
    remoteRoom([view({ conference: 'en-cours', sessionStates: { 'talk-1': 'running' } })])
    const talk = useTalkStore()

    talk.askEnd()
    await flushPromises()

    // "Terminer" sits next to "Commencer", and that neighbouring gets paid for
    // once per event: when early, it asks for confirmation.
    expect(talk.endEarlyOpen).toBe(true)
    expect(types()).toEqual([])
    expect(talk.endEarlyDetail).toContain('rien dans la salle')
  })

  it('ends without asking anything once the hour has passed', async () => {
    const after = Date.parse('2026-10-30T09:50:00.000Z')
    remoteRoom([
      view({
        serverTime: new Date(after).toISOString(),
        conference: 'depassement',
        sessionStates: { 'talk-1': 'running' },
      }),
    ])
    const talk = useTalkStore()

    talk.askEnd()
    await flushPromises()

    // The day's normal gesture: confirming it every time would turn it into a
    // reflex, which amounts to no longer reading it.
    expect(talk.endEarlyOpen).toBe(false)
    expect(types()).toEqual(['session.end'])
  })
})
