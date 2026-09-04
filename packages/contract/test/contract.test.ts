import { describe, expect, it } from 'vitest'
import { ulid } from './ulid.js'
import {
  DELIVERY_BY_EVENT,
  DEFAULT_VOD_POLICY,
  PROTOCOL_VERSION,
  commandPayloadSchema,
  commandSchema,
  contract,
  envelopeSchema,
  hubSettingsSchema,
  sessionStateSchema,
  sessionStateViewSchema,
  isCommandExpired,
  roomEventPayloadSchema,
  sceneRoleMapSchema,
  syncResultSchema,
} from '../src/index.js'

const NOW = '2026-10-30T09:00:00.000+00:00'

const envelopeOf = (payload: unknown, overrides: Record<string, unknown> = {}) => ({
  id: ulid(),
  roomId: 'track-1-teilhard-de-chardin',
  seq: 42,
  occurredAt: NOW,
  monotonicMs: 123_456,
  delivery: 'required',
  payload,
  ...overrides,
})

describe('outbox envelope', () => {
  it('validates a complete recording event', () => {
    const parsed = envelopeSchema.parse(
      envelopeOf({
        type: 'recording.stopped',
        obs: 'B',
        sessionId: 'ses-1',
        outputPath: '/rec/2026-10-30_track1_1100_honeyswamp.mkv',
        durationMs: 3_000_000,
        sidecarWritten: true,
      }),
    )
    expect(parsed.payload.type).toBe('recording.stopped')
    expect(parsed.delivery).toBe('required')
  })

  it('refuses an id that is not a ULID', () => {
    expect(() => envelopeSchema.parse(envelopeOf({ type: 'incident', level: 'warn', message: 'x' }, { id: 'not-a-ulid' })))
      .toThrow()
  })

  it('refuses an unknown event type', () => {
    expect(() => envelopeSchema.parse(envelopeOf({ type: 'type.invente', foo: 1 }))).toThrow()
  })

  it('survives a JSON round trip', () => {
    const envelope = envelopeSchema.parse(
      envelopeOf({ type: 'talk.marker', sessionId: 'ses-1', label: 'démo', offsetMs: 90_000 }),
    )
    expect(envelopeSchema.parse(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope)
  })
})

describe('delivery policies', () => {
  it('covers every event type exhaustively', () => {
    const declared = roomEventPayloadSchema.options
      .map((option) => option.shape.type.value as string)
      .sort()
    expect(Object.keys(DELIVERY_BY_EVENT).sort()).toEqual(declared)
  })

  it('classes telemetry as best-effort and the rest as required', () => {
    expect(DELIVERY_BY_EVENT['room.heartbeat']).toBe('best-effort')
    expect(DELIVERY_BY_EVENT['stream.telemetry']).toBe('best-effort')
    expect(DELIVERY_BY_EVENT['recording.started']).toBe('required')
    expect(DELIVERY_BY_EVENT['talk.marker']).toBe('required')
  })
})

describe('downstream commands', () => {
  const command = (payload: unknown, ttlSeconds: number | null) =>
    commandSchema.parse({ seq: 7, issuedAt: NOW, ttlSeconds, payload })

  it('validates every command type', () => {
    expect(() => commandPayloadSchema.parse({ type: 'scene.force', role: 'HOLD' })).not.toThrow()
    expect(() =>
      commandPayloadSchema.parse({ type: 'message.broadcast', text: 'Salle évacuée', level: 'urgent' }),
    ).not.toThrow()
    expect(() => commandPayloadSchema.parse({ type: 'scene.force', role: 'SCENE_INEXISTANTE' })).toThrow()
  })

  it('applies `display.set` with no explicit sessionId', () => {
    const parsed = commandPayloadSchema.parse({ type: 'display.set', mode: 'sponsors' })
    expect(parsed).toEqual({ type: 'display.set', mode: 'sponsors', sessionId: null })
  })

  it('discards a command caught up after expiry', () => {
    const lunch = command({ type: 'message.broadcast', text: 'Pause déjeuner', level: 'info' }, 600)
    const issuedMs = Date.parse(NOW)
    expect(isCommandExpired(lunch, issuedMs + 5 * 60_000)).toBe(false)
    // Reconnection 40 minutes later: the message must no longer be shown.
    expect(isCommandExpired(lunch, issuedMs + 40 * 60_000)).toBe(true)
  })

  it('keeps a command with no TTL indefinitely', () => {
    const forced = command({ type: 'scene.force', role: 'LIVE' }, null)
    expect(isCommandExpired(forced, Date.parse(NOW) + 86_400_000)).toBe(false)
  })
})

describe('room configuration', () => {
  it('accepts a partial role mapping', () => {
    // OBS-A only has LIVE and HOLD: that is the nominal case, not an error.
    const parsed = sceneRoleMapSchema.parse({
      A: { LIVE: 'Capture HDMI', HOLD: 'Habillage web' },
      B: { TALK: 'Talk complet', CAM_ONLY: 'Caméra seule' },
    })
    expect(parsed.A.LIVE).toBe('Capture HDMI')
    expect(parsed.B.RELAY).toBeUndefined()
  })
})

describe('contract surface', () => {
  it('exposes the procedures each application expects', () => {
    expect(Object.keys(contract).sort()).toEqual([
      'clock',
      'devices',
      // The event's identity, read-only: what the hub decided for the name shown
      // everywhere, and what it would derive with no setting.
      'event',
      'ingest',
      'messages',
      'meta',
      // A surface of its own, and not one more mode on the room screen: the
      // banner overlays the video where a screen message replaces everything.
      'overlay',
      'program',
      // Notifications that survive closing the console: supervision gets watched
      // on a phone tucked in a pocket.
      'push',
      'questions',
      'regie',
      'rooms',
      'sessions',
      'settings',
      // Shipping the rushes back: the hub holds the storage keys and signs
      // addresses, the room uploads. No secret goes down to a room.
      'vod',
      'wall',
    ])
    // The lifecycle is drivable from both sides: room control app and console.
    // `override` corrects the program itself — a lunch break the export calls a
    // talk — where the other four drive how it runs.
    expect(Object.keys(contract.sessions).sort()).toEqual([
      'end',
      // Corrects a slot's OpenFeedback identifier when the export's does not
      // match: without it, a dead QR code cannot be repaired.
      'feedbackId',
      'override',
      'reset',
      'start',
      'states',
    ])
    expect(Object.keys(contract.program).sort()).toEqual([
      'activate',
      // The console's only outgoing call: compares the program's identifiers with
      // what OpenFeedback knows, on demand and never in the background.
      'controleOpenFeedback',
      'globalBreak',
      'import',
      'planning',
      'snapshots',
    ])
    expect(Object.keys(contract.rooms).sort()).toEqual([
      'commands',
      // A room configures itself: the OBS addresses and the scene names are
      // established in front of the machines, not from the console.
      'configure',
      // Public: the wall tells attendees what they are listening to.
      'current',
      'list',
      // Public: an unpaired machine must be able to offer a room choice.
      'public',
      // A console gesture: putting a room straight without restarting it, and so
      // without cutting its capture.
      'resync',
      'statuses',
      'sync',
    ])
    // Pairing goes through Better Auth; the contract only carries the business
    // part (which room) that Better Auth does not know.
    expect(Object.keys(contract.devices).sort()).toEqual([
      'approve',
      'claim',
      'deny',
      'list',
      'lookup',
      'pending',
      'revoke',
    ])
    // Five room procedures and four console ones. The former are bounded to the
    // calling room by its token — none has a `roomId` in its input —, the latter
    // only look and ask: the console does not hold the files, it cannot upload on
    // anyone's behalf.
    expect(Object.keys(contract.vod).sort()).toEqual([
      'abort',
      // Opens *or resumes*: that is what makes an outage at 90% recoverable.
      'begin',
      // The real gesture, not a probe: open, sign, write, abandon.
      'check',
      'complete',
      // *One* talk's folder: the control app's takes and the objects at the
      // storage. The other reading direction from `uploads`, which sorts by file.
      'conference',
      'parts',
      'progress',
      'request',
      // Erases the bucket prefix and the rooms' rushes. Development only, and
      // refused on the server side — not merely absent from the console.
      'reset',
      'status',
      'uploads',
    ])
  })

  it('exposes no catch-up parameter on the command flow', () => {
    // Resumption goes through oRPC's `lastEventId`, not a home-made `sinceSeq`.
    const inputsOf = (procedure: unknown): unknown[] | undefined =>
      (procedure as { '~orpc': { inputSchemas?: unknown[] } })['~orpc'].inputSchemas

    expect(inputsOf(contract.rooms.commands)).toBeUndefined()
    // Check that the introspection above is not meaningless: a procedure that
    // does take an input must declare one.
    expect(inputsOf(contract.rooms.sync)).toHaveLength(1)
  })

  it('pins the protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(1)
    expect(() =>
      syncResultSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        contentHash: 'abc',
        program: null,
        room: {
          id: 'track-1',
          name: 'Track 1',
          trackId: 'track-1',
          obs: { A: { url: 'ws://127.0.0.1:4455', password: null }, B: { url: 'ws://127.0.0.1:4456', password: null } },
          sceneRoles: { A: { LIVE: 'Live', HOLD: 'Hold' }, B: { TALK: 'Talk' } },
        },
        overrides: [],
        serverTime: NOW,
      }),
    ).not.toThrow()
  })
})

describe('talk lifecycle', () => {
  it('has no stored "upcoming" state', () => {
    // `scheduled` is the absence of state: storing it would mean recording that
    // nothing happened.
    const state = sessionStateSchema.parse({
      sessionId: 'ses-1',
      roomId: 'track-1',
      status: 'running',
      startedAt: '2026-10-30T10:00:00.000+00:00',
      endedAt: null,
      decidedBy: 'regie@cloudnord.fr',
    })
    expect(state.status).toBe('running')
    expect(() => sessionStateSchema.parse({ ...state, status: 'inventé' })).toThrow()
  })

  it('bounds the automatic closing delay', () => {
    expect(hubSettingsSchema.parse({})).toEqual({
      autoEndEnabled: true,
      autoEndGraceMinutes: 5,
      // No account declared to start with: the rooms' loop skips its social page
      // rather than showing an empty frame.
      socialLinks: [],
      programSourceUrl: null,
      // Nothing about the event is set by default: the hub derives it from the
      // imported program, and that is what makes the repository agnostic.
      eventName: null,
      eventShortName: null,
      openFeedbackProjectId: null,
      // No storage, and above all: nothing that leaves on its own. The default
      // must be the case where no byte leaves a room unless asked.
      vodBucket: null,
      vodPrefix: null,
      vodPolitique: DEFAULT_VOD_POLICY,
    })
    expect(DEFAULT_VOD_POLICY.actif).toBe(false)
    expect(DEFAULT_VOD_POLICY.debitMaxOctetsS).toBeNull()
    // Five megabytes is S3's minimum multipart part size: going below would
    // produce uploads refused at the last step.
    expect(() => hubSettingsSchema.parse({ vodPolitique: { taillePartMo: 4 } })).toThrow()
    expect(() => hubSettingsSchema.parse({ autoEndGraceMinutes: -1 })).toThrow()
    // Two hours of grace would no longer be automatic in any sense.
    expect(() => hubSettingsSchema.parse({ autoEndGraceMinutes: 121 })).toThrow()
    // The URL is validated as such: a "yes" typed into the console must not be
    // discovered at the next startup, when the hub attempts the import.
    expect(() => hubSettingsSchema.parse({ programSourceUrl: 'not-a-url' })).toThrow()
  })

  it('carries a state change to every room', () => {
    const command = commandPayloadSchema.parse({
      type: 'session.state',
      sessionId: 'ses-1',
      roomId: 'track-2-mf-1092',
      sessionTitle: 'HoneySwamp',
      status: 'ended',
      decidedBy: 'auto',
    })
    // The room and the title travel with it: a control app must be able to report
    // "HoneySwamp has just finished next door" without asking the hub.
    expect(command).toMatchObject({
      roomId: 'track-2-mf-1092',
      sessionTitle: 'HoneySwamp',
      decidedBy: 'auto',
    })
  })

  it('enriches the talk state for the console', () => {
    // An opaque identifier cannot be read, and allows no time computation.
    const view = sessionStateViewSchema.parse({
      sessionId: 'ses-1',
      roomId: 'track-1',
      status: 'running',
      startedAt: '2026-10-30T10:02:00.000+00:00',
      endedAt: null,
      decidedBy: 'regie@cloudnord.fr',
      title: 'HoneySwamp',
      roomName: 'Track #1',
      scheduledStartsAt: '2026-10-30T10:00:00.000+00:00',
      scheduledEndsAt: '2026-10-30T10:50:00.000+00:00',
    })
    expect(view.title).toBe('HoneySwamp')
    expect(view.scheduledEndsAt).toBeTruthy()
  })
})

describe('message exchange', () => {
  it("tells a message's recipient apart", () => {
    const forTheOperator = commandPayloadSchema.parse({
      type: 'message.broadcast',
      text: 'Ton speaker est arrivé',
      level: 'info',
      target: 'operator',
    })
    // Without this distinction, a note to the operator would show up in large
    // type in front of the audience.
    expect(forTheOperator).toMatchObject({ target: 'operator', from: null })

    expect(() =>
      commandPayloadSchema.parse({
        type: 'message.broadcast',
        text: 'x',
        level: 'urgent',
        target: 'everyone',
      }),
    ).toThrow()
  })

  it('keeps the control app banner by default', () => {
    // The least damaging default: a message that only reaches the operator can be
    // recovered from, a message projected by mistake cannot.
    const byDefault = commandPayloadSchema.parse({
      type: 'message.broadcast',
      text: 'coucou',
      level: 'info',
    })
    expect(byDefault).toMatchObject({ target: 'operator' })
  })

  it('classes a room message as required', () => {
    const envelope = envelopeSchema.parse({
      id: '01JB2ZK5T7QW9V0YHRXM3N4P6C',
      roomId: 'track-1',
      seq: 1,
      occurredAt: '2026-10-30T10:00:00.000+00:00',
      monotonicMs: 1,
      delivery: 'required',
      payload: { type: 'room.message', text: "Besoin d'aide", level: 'urgent' },
    })
    expect(envelope.payload.type).toBe('room.message')
    // A call for help sent during an outage must arrive, even late.
    expect(DELIVERY_BY_EVENT['room.message']).toBe('required')
  })
})
