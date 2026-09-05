import type { ControlCommand, ControlView } from '@conference-operator/contract'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  OBSERVATION_MS,
  payloadFromView,
  remoteGateway,
  translate,
  type ActionResult,
  type StateSink,
} from '../src/lib/gateway.js'
import { talk } from './fixtures.js'

/**
 * The hub's gateway, and the only thing it promises.
 *
 * `regie.command` answers once the hub has **queued the command**. Whether the
 * room obeyed is only observable on the next view. This file's whole value lies in
 * that distinction: it is what decides whether "Commencer"'s warning stays honest,
 * or becomes a lie discovered while reviewing the VOD.
 */

const AT = Date.parse('2026-10-30T09:10:00.000Z')

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

/**
 * An oRPC client reduced to what the gateway calls.
 *
 * `views` is a queue: each poll consumes one, and the last one then holds. That is
 * what allows "the room eventually confirms" and "the room never confirms" to be
 * described with the same tool.
 */
function fakeClient(views: ControlView[]) {
  const commands: ControlCommand[] = []
  let remaining = [...views]
  return {
    commands,
    client: {
      rpc: {
        regie: {
          view: async () => {
            const next_ = remaining.length > 1 ? remaining.shift()! : remaining[0]!
            return next_
          },
          command: async ({ action }: { action: ControlCommand }) => {
            commands.push(action)
            return { ok: true, applied: 'queued' as const }
          },
        },
      },
    } as never,
  }
}

const silentStream: StateSink = { onPayload: () => {}, onOutage: () => {} }

describe('translating a control gesture', () => {
  it('carries the lifecycle target, taken from the view', () => {
    // The target travels explicitly: the slot aimed at can turn over between the
    // render and the click, and that is where an implicit target starts the wrong talk.
    expect(translate({ action: 'session.start' }, view())).toEqual({
      type: 'session.start',
      sessionId: 'talk-1',
    })
  })

  it('refuses the lifecycle when the room is driving no talk', () => {
    expect(translate({ action: 'session.end' }, view({ targetSession: null }))).toBeNull()
  })

  it('returns a state rather than a verb for the take and the stream', () => {
    /*
     * `on: boolean` and not `start`/`stop`: a command caught up on then describes an
     * intent that is still readable, and applying it twice costs nothing — which
     * matters on an at-least-once stream.
     */
    expect(translate({ action: 'recording.start' }, view())).toEqual({
      type: 'recording.set',
      on: true,
    })
    expect(translate({ action: 'stream.stop' }, view())).toEqual({ type: 'stream.set', on: false })
  })

  it('carries the room screen, which goes through the downstream flow', () => {
    /*
     * The screen mode asks for nothing more than a scene switch: the command
     * already exists on the room side, and the hub knows how to publish it. That is
     * what lets it be driven from a phone with nothing added between it and the room
     * machine.
     */
    expect(translate({ action: 'display.set', mode: 'sponsors' }, view())).toEqual({
      type: 'display.set',
      mode: 'sponsors',
    })
  })

  it('discards everything that requires the room machine', () => {
    // The markers, the VOD, the ⚙: the hub has neither the disk nor the OBS
    // instances. The short table *is* the definition of the scope.
    for (const action of [
      'recording.mark',
      'vod.upload',
      'room.configure',
      'obs.connect',
      'message.send',
    ]) {
      expect(translate({ action }, view())).toBeNull()
    }
  })
})

describe('poster un geste', () => {
  let gateway: ReturnType<typeof remoteGateway>
  let clock: number

  function open(views: ControlView[]) {
    clock = AT
    const { client, commands } = fakeClient(views)
    gateway = remoteGateway({
      client,
      roomId: 'track-1',
      now: () => clock,
      // The wait advances the test clock rather than sleeping: the guard delay is
      // checked in simulated milliseconds.
      wait: async (ms) => {
        clock += ms
      },
    })
    return commands
  }

  beforeEach(() => {
    clock = AT
  })

  it('refuses in so many words what requires the room\'s control app', async () => {
    open([view()])
    const result: ActionResult = await gateway.act({ action: 'recording.mark', label: 'x' })
    // Letting the call fail on a refusal from the hub would give a red with no
    // explanation, where the reason fits in one sentence.
    expect(result).toEqual({ ok: false, message: 'Ce geste demande la régie de la salle' })
  })

  it('waits for nothing behind a scene switch', async () => {
    const commands = open([view()])
    gateway.start(silentStream)
    const result = await gateway.act({ action: 'scene.set', role: 'LIVE' })
    gateway.stop()

    expect(commands).toEqual([{ type: 'scene.set', role: 'LIVE' }])
    // The switch is read on the button at the next poll, as in the room's own
    // control app: nobody chains anything onto it.
    expect(result.ok).toBe(true)
  })

  it('confirms the take by observation, not by the response', async () => {
    /*
     * The hub answers "queued"; the room may be cut off, OBS may refuse. Without
     * this wait, `launch()` would chain onto `session.start` believing it was
     * recording — and "Commencer"'s warning would become a lie discovered in the
     * evening, in front of a missing VOD.
     */
    open([view({ recording: false }), view({ recording: true })])
    const result = await gateway.act({ action: 'recording.start' })
    expect(result.ok).toBe(true)
  })

  it('declares the take missed when the room never confirms', async () => {
    open([view({ recording: false })])
    const start = clock
    const result = await gateway.act({ action: 'recording.start' })

    expect(result.ok).toBe(false)
    expect(result.message).toContain("n'a pas démarré")
    // Bounded: a room that is cut off must not leave the page waiting forever.
    expect(clock - start).toBeGreaterThanOrEqual(OBSERVATION_MS)
  })
})

describe('the view rendered in the shape the panels read', () => {
  it("installs the offset against the hub's clock, not the phone's", () => {
    // The hub's clock is authoritative and may be simulated: in development the
    // offset is measured in weeks, and the browser only has its own.
    const rendered = payloadFromView(view(), AT - 60_000)
    expect(rendered.state.serverTimeOffsetMs).toBe(60_000)
  })

  it('carries the start-up guards, so the question is the same as in the room', () => {
    const rendered = payloadFromView(view({ promptRecordingOnStart: false, sceneOnStart: null }), AT)
    expect(rendered.diagnostics?.config?.promptRecordingOnStart).toBe(false)
    expect(rendered.diagnostics?.config?.sceneOnStart).toBeNull()
  })

  it('offers only the scene roles the room has mapped', () => {
    const rendered = payloadFromView(view({ sceneRoles: ['LIVE', 'HOLD'] }), AT)
    expect(Object.keys(rendered.diagnostics!.config!.sceneRoles.A)).toEqual(['LIVE', 'HOLD'])
  })

  it('installs the screen the room reported, not the one that was asked for', () => {
    // The panel reads `state.mode`: it is what decides which button lights up, and
    // it must describe the room, never the intent.
    expect(payloadFromView(view({ displayMode: 'feedback' }), AT).state.mode).toBe('feedback')
  })

  it('falls back on the loop when the room has not beaten yet', () => {
    /*
     * `loop` is not filler: it is the state a room starts in. A room that has
     * reported nothing does therefore show the loop — and if it is cut off, the
     * connectivity says so right beside it.
     */
    expect(payloadFromView(view({ displayMode: null }), AT).state.mode).toBe('loop')
  })

  it('leaves empty what the hub does not know, rather than invent it', () => {
    const rendered = payloadFromView(view({ recording: true }), AT)
    /*
     * The hub stores only a boolean. A plausible start time beside a correct red dot
     * would show a wrong duration — and cast doubt on both. The editing anchors fall
     * with it: they live in the take, on the room machine, and the hub knows nothing
     * of them.
     */
    expect(rendered.diagnostics?.recording).toEqual({
      active: true,
      markers: 0,
      startedAtMs: null,
      startedAtCorrectedMs: null,
      editing: { startMs: null, endMs: null },
    })
    // `remoteHolder` tells a *room* that it is being driven remotely; on the phone
    // doing the driving it has nobody to warn.
    expect(rendered.state.remoteHolder).toBeNull()
    // No pairing: that is a room-machine matter, and a pairing veil on a phone
    // would have no code to display.
    expect(rendered.pairing).toBeNull()
  })
})
