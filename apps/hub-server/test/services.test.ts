import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForRender } from './helpers/wait-for-render.js'
import { openHubDatabase, type HubDatabase } from '../src/db.js'
import { ProgramService } from '../src/services/program.js'
import { CommandService } from '../src/services/commands.js'
import { IngestService } from '../src/services/ingest.js'
import { DeviceService, RoomService } from '../src/services/rooms.js'
import { SettingsService } from '../src/services/sessions.js'

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const TRACK_1 = 'track-1-teilhard-de-chardin'
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'
const OTHER_CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6D'

let db: HubDatabase
beforeEach(() => {
  db = openHubDatabase(':memory:').orm
})

function seedRoom(rooms: RoomService, id = TRACK_1): void {
  rooms.upsert({
    id,
    name: 'Track #1',
    trackId: id,
    obs: {
      A: { url: 'ws://127.0.0.1:4455', password: null },
      B: { url: 'ws://127.0.0.1:4456', password: null },
    },
    sceneRoles: { A: { LIVE: 'Capture', HOLD: 'Habillage' }, B: { TALK: 'Talk' } },
    displayPort: 7788,
    recordingRoot: null,
  })
}

const envelope = (id: string, seq: number, payload: unknown, roomId = TRACK_1) => ({
  id,
  roomId,
  seq,
  occurredAt: '2026-10-30T09:00:00.000+00:00',
  monotonicMs: seq * 1000,
  delivery: 'required',
  payload,
})

describe('ProgramService', () => {
  it('imports, normalizes and activates a snapshot', () => {
    const programs = new ProgramService(db)
    const snapshot = programs.importFromText(rawProgram, 'https://exemple/programme.json')

    expect(snapshot.program.sessions).toHaveLength(27)
    expect(snapshot.program.rooms).toHaveLength(3)
    expect(programs.active()?.contentHash).toBe(snapshot.contentHash)
  })

  it('creates no duplicate when the source has not changed', () => {
    const programs = new ProgramService(db)
    const first = programs.importFromText(rawProgram, 'https://exemple/programme.json')
    const second = programs.importFromText(rawProgram, 'https://exemple/programme.json')

    expect(second.contentHash).toBe(first.contentHash)
    expect(programs.list()).toHaveLength(1)
  })

  it('allows going back to a previous snapshot', () => {
    const programs = new ProgramService(db)
    const original = programs.importFromText(rawProgram, 'https://exemple/programme.json')

    // An import on the day that empties the program: exactly what one wants to
    // undo.
    const broken = JSON.parse(rawProgram)
    broken.sessions = []
    const bad = programs.importFromText(JSON.stringify(broken), 'https://exemple/programme.json')
    expect(programs.active()?.contentHash).toBe(bad.contentHash)

    programs.activate(original.contentHash)
    // 27 slots in the export, 38 served: the eleven extra ones are the shared
    // breaks projected into the rooms that have nothing scheduled at that moment.
    // `active()` serves the program, not the imported file.
    expect(programs.active()?.program.sessions).toHaveLength(38)
    expect(programs.list()).toHaveLength(2)
  })
})

describe('CommandService', () => {
  it('assigns increasing `seq`s and replays the backlog', () => {
    const rooms = new RoomService(db)
    seedRoom(rooms)
    const commands = new CommandService(db)

    const first = commands.publish(TRACK_1, { type: 'scene.force', role: 'HOLD' }, null)
    const second = commands.publish(TRACK_1, { type: 'scene.force', role: 'LIVE' }, null)
    expect(second.seq).toBeGreaterThan(first.seq)

    expect(commands.backlog(TRACK_1, 0).map((c) => c.seq)).toEqual([first.seq, second.seq])
    expect(commands.backlog(TRACK_1, first.seq).map((c) => c.seq)).toEqual([second.seq])
  })

  it('mixes global broadcasts and room commands without breaking the order', () => {
    const rooms = new RoomService(db)
    seedRoom(rooms)
    seedRoom(rooms, 'track-2')
    const commands = new CommandService(db)

    const forRoom1 = commands.publish(TRACK_1, { type: 'scene.force', role: 'HOLD' }, null)
    const broadcast = commands.publish(
      null,
      { type: 'message.broadcast', text: 'Évacuation', level: 'urgent' },
      600,
    )
    const forRoom2 = commands.publish('track-2', { type: 'scene.force', role: 'LIVE' }, null)

    // It is this case that imposes a global `seq`: room 1 sees its command then
    // the broadcast, with strictly increasing `seq`s — the condition for resuming
    // by `lastEventId` to skip nothing.
    const seen = commands.backlog(TRACK_1, 0).map((c) => c.seq)
    expect(seen).toEqual([forRoom1.seq, broadcast.seq])
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
    expect(commands.backlog('track-2', 0).map((c) => c.seq)).toEqual([broadcast.seq, forRoom2.seq])
  })

  it('chains catch-up then real time in the same stream', async () => {
    const rooms = new RoomService(db)
    seedRoom(rooms)
    const commands = new CommandService(db)
    const before = commands.publish(TRACK_1, { type: 'scene.force', role: 'HOLD' }, null)

    const controller = new AbortController()
    const received: number[] = []
    const consumer = (async () => {
      for await (const command of commands.stream(TRACK_1, 0, controller.signal)) {
        received.push(command.seq)
        if (received.length === 2) controller.abort()
      }
    })()

    // Let the catch-up drain before publishing live.
    await waitForRender()
    const live = commands.publish(TRACK_1, { type: 'scene.force', role: 'LIVE' }, null)
    await consumer

    expect(received).toEqual([before.seq, live.seq])
  })

  it('resumes after `sinceSeq` without handing back what is already applied', async () => {
    const rooms = new RoomService(db)
    seedRoom(rooms)
    const commands = new CommandService(db)
    const applied = commands.publish(TRACK_1, { type: 'scene.force', role: 'HOLD' }, null)
    const missed = commands.publish(TRACK_1, { type: 'scene.force', role: 'LIVE' }, null)

    const controller = new AbortController()
    const received: number[] = []
    for await (const command of commands.stream(TRACK_1, applied.seq, controller.signal)) {
      received.push(command.seq)
      controller.abort()
    }
    expect(received).toEqual([missed.seq])
  })
})

describe('IngestService', () => {
  it('absorbs a replayed batch without duplicating', () => {
    const rooms = new RoomService(db)
    seedRoom(rooms)
    const ingest = new IngestService(db)

    const batch = [
      envelope('01AAAAAAAAAAAAAAAAAAAAAAAA', 1, {
        type: 'recording.started',
        obs: 'B',
        sessionId: 'ses-1',
      }),
      envelope('01BBBBBBBBBBBBBBBBBBBBBBBB', 2, {
        type: 'talk.marker',
        sessionId: 'ses-1',
        label: 'démo',
        offsetMs: 90_000,
      }),
    ]

    const first = ingest.push(TRACK_1, batch)
    expect(first.acked).toHaveLength(2)
    expect(first.duplicates).toHaveLength(0)

    // Reconnection: the client replays the batch without knowing whether it got
    // through.
    const replay = ingest.push(TRACK_1, batch)
    expect(replay.acked).toHaveLength(0)
    expect(replay.duplicates).toHaveLength(2)
  })

  it('takes over to the hub an OpenFeedback project entered on a control app', () => {
    // The field used to be editable in each room's ⚙. Removing it without taking
    // anything over would have switched off the links of the only room that had
    // any — which is exactly the state of the development hub: empty event
    // setting, room 1 filled in, two rooms silent.
    const rooms = new RoomService(db)
    seedRoom(rooms)
    const settings = new SettingsService(db)
    const room = rooms.get(TRACK_1)!
    rooms.upsert({ ...room, openFeedbackProjectId: 'cloud-nord-2026' })

    const takeover = rooms.takeOverOpenFeedbackProject(settings)

    expect(takeover.adopted).toBe('cloud-nord-2026')
    expect(settings.get().openFeedbackProjectId).toBe('cloud-nord-2026')
    // Erased on the room side: a field nothing reads any more ends up rising from
    // the dead.
    expect(rooms.get(TRACK_1)?.openFeedbackProjectId).toBeNull()
  })

  it('takes nothing over when the hub already has its project', () => {
    const rooms = new RoomService(db)
    seedRoom(rooms)
    const settings = new SettingsService(db)
    settings.update({ openFeedbackProjectId: 'cloud-nord-2026' })
    const room = rooms.get(TRACK_1)!
    rooms.upsert({ ...room, openFeedbackProjectId: 'atelier-2026' })

    const takeover = rooms.takeOverOpenFeedbackProject(settings)

    // The console's setting is authoritative: the room's value is erased without
    // having had a say.
    expect(takeover.adopted).toBeNull()
    expect(settings.get().openFeedbackProjectId).toBe('cloud-nord-2026')
    expect(rooms.get(TRACK_1)?.openFeedbackProjectId).toBeNull()
  })

  it('rewrites nothing on the next start', () => {
    // Idempotence: the takeover runs at every start, and a hub installed six
    // months ago must not go over its rooms every time.
    const rooms = new RoomService(db)
    seedRoom(rooms)
    const settings = new SettingsService(db)
    const room = rooms.get(TRACK_1)!
    rooms.upsert({ ...room, openFeedbackProjectId: 'cloud-nord-2026' })

    rooms.takeOverOpenFeedbackProject(settings)
    const second = rooms.takeOverOpenFeedbackProject(settings)

    expect(second).toEqual({ adopted: null, cleanedRooms: [] })
  })

  it('recomposes the takes from the two ends the room reported', () => {
    const rooms = new RoomService(db)
    seedRoom(rooms)
    const ingest = new IngestService(db)

    ingest.push(TRACK_1, [
      {
        ...envelope('01F1AAAAAAAAAAAAAAAAAAAAAA', 1, {
          type: 'recording.started',
          obs: 'B',
          sessionId: 'ses-1',
        }),
        occurredAt: '2026-10-30T10:00:00.000+00:00',
      },
      {
        ...envelope('01F2AAAAAAAAAAAAAAAAAAAAAA', 2, {
          type: 'recording.stopped',
          obs: 'B',
          sessionId: 'ses-1',
          outputPath: '/rushes/ses-1.mkv',
          durationMs: 2_700_000,
          sidecarWritten: true,
        }),
        occurredAt: '2026-10-30T10:45:00.000+00:00',
      },
    ])

    // The hub does not read the control machine's disk: it pairs the start and
    // the stop, and it is the stop that carries the written file.
    // `captations`, `enCours` and `finInconnue` are contract names.
    expect(ingest.captations(TRACK_1)).toEqual([
      {
        roomId: TRACK_1,
        obs: 'B',
        sessionId: 'ses-1',
        startedAt: '2026-10-30T10:00:00.000+00:00',
        endedAt: '2026-10-30T10:45:00.000+00:00',
        durationMs: 2_700_000,
        file: '/rushes/ses-1.mkv',
        sidecarWritten: true,
        enCours: false,
        finInconnue: false,
      },
    ])
  })

  it('does not attribute one OBS instance\'s file to the other', () => {
    const rooms = new RoomService(db)
    seedRoom(rooms)
    const ingest = new IngestService(db)

    // Both run at the same time in some rooms. Pairing in arrival order, without
    // looking at the instance, would give B's file to A's take.
    ingest.push(TRACK_1, [
      envelope('01G1AAAAAAAAAAAAAAAAAAAAAA', 1, { type: 'recording.started', obs: 'A', sessionId: 'ses-1' }),
      envelope('01G2AAAAAAAAAAAAAAAAAAAAAA', 2, { type: 'recording.started', obs: 'B', sessionId: 'ses-1' }),
      envelope('01G3AAAAAAAAAAAAAAAAAAAAAA', 3, {
        type: 'recording.stopped',
        obs: 'B',
        sessionId: 'ses-1',
        outputPath: '/rushes/depuis-B.mkv',
        durationMs: 1_000,
        sidecarWritten: false,
      }),
    ])

    const takes = ingest.captations(TRACK_1)
    expect(takes.find((take) => take.obs === 'B')).toMatchObject({
      file: '/rushes/depuis-B.mkv',
      enCours: false,
    })
    // A was never stopped: it comes out open, and with no file.
    expect(takes.find((take) => take.obs === 'A')).toMatchObject({
      file: null,
      enCours: true,
    })
  })

  it('does not let a superseded take pass for active', () => {
    // Observed on a three-day development room: four "recording in progress"
    // stacked above the only row that said something. A `started` with no
    // `stopped`, then another `started`: the hub will never hear the first one's
    // stop, and presenting it as active is false.
    const rooms = new RoomService(db)
    seedRoom(rooms)
    const ingest = new IngestService(db)

    ingest.push(TRACK_1, [
      envelope('01M1AAAAAAAAAAAAAAAAAAAAAA', 1, { type: 'recording.started', obs: 'B', sessionId: null }),
      envelope('01M2AAAAAAAAAAAAAAAAAAAAAA', 2, { type: 'recording.started', obs: 'B', sessionId: null }),
      envelope('01M3AAAAAAAAAAAAAAAAAAAAAA', 3, { type: 'recording.started', obs: 'B', sessionId: null }),
    ])

    const takes = ingest.captations(TRACK_1)
    expect(takes).toHaveLength(3)
    // The first two: superseded, so closed and reported as such.
    expect(takes.slice(0, 2).every((t) => !t.enCours && t.finInconnue)).toBe(true)
    // Only the last one can still be running.
    expect(takes[2]).toMatchObject({ enCours: true, finInconnue: false })
  })

  it('forgets the takes on a reset, and nothing else', () => {
    // The reset erases the bucket and the rooms' disks. Without this gesture, the
    // hub kept the memory of takes whose files no longer exist, and the VOD folder
    // kept listing them — the reset looked like it had no effect.
    const rooms = new RoomService(db)
    seedRoom(rooms)
    const ingest = new IngestService(db)

    ingest.push(TRACK_1, [
      envelope('01N1AAAAAAAAAAAAAAAAAAAAAA', 1, { type: 'recording.started', obs: 'B', sessionId: null }),
      envelope('01N2AAAAAAAAAAAAAAAAAAAAAA', 2, {
        type: 'recording.stopped', obs: 'B', sessionId: null,
        outputPath: '/rushes/x.mkv', durationMs: 1000, sidecarWritten: true,
      }),
      envelope('01N3AAAAAAAAAAAAAAAAAAAAAA', 3, {
        type: 'room.message', text: 'micro HS', level: 'warning',
      }),
    ])

    const erased = ingest.forgetCaptures()

    expect(erased).toBe(2)
    expect(ingest.captations(TRACK_1)).toEqual([])
    // A day's diagnosis has nothing to do with the rushes: it stays.
    expect(ingest.messagesFromRooms()).toHaveLength(1)
  })

  it('discards a malformed event without blocking the others', () => {
    const rooms = new RoomService(db)
    seedRoom(rooms)
    const ingest = new IngestService(db)

    const outcome = ingest.push(TRACK_1, [
      { id: 'not-a-ulid', roomId: TRACK_1, seq: 1, payload: { type: 'inconnu' } },
      envelope('01CCCCCCCCCCCCCCCCCCCCCCCC', 2, { type: 'incident', level: 'warn', message: 'ok' }),
    ])

    expect(outcome.rejected).toEqual([{ id: 'not-a-ulid', reason: 'invalid-schema' }])
    expect(outcome.acked).toEqual(['01CCCCCCCCCCCCCCCCCCCCCCCC'])
  })

  it('refuses an event stamped for another room', () => {
    const rooms = new RoomService(db)
    seedRoom(rooms)
    const outcome = new IngestService(db).push(TRACK_1, [
      envelope('01DDDDDDDDDDDDDDDDDDDDDDDD', 1, { type: 'incident', level: 'warn', message: 'x' }, 'track-2'),
    ])
    expect(outcome.rejected).toEqual([{ id: '01DDDDDDDDDDDDDDDDDDDDDDDD', reason: 'unknown-room' }])
  })

  it('projects the events onto the supervision view', () => {
    const rooms = new RoomService(db)
    seedRoom(rooms)
    const ingest = new IngestService(db)

    ingest.push(TRACK_1, [
      envelope('01EEEEEEEEEEEEEEEEEEEEEEEE', 1, {
        type: 'room.heartbeat',
        connectivity: 'ONLINE',
        sceneRole: 'HOLD',
        recording: false,
        streaming: false,
        outboxDepth: 3,
        programContentHash: 'abc123',
      }),
    ])

    const status = rooms.statuses().find((s) => s.roomId === TRACK_1)
    expect(status).toMatchObject({
      connectivity: 'ONLINE',
      sceneRole: 'HOLD',
      outboxDepth: 3,
      programContentHash: 'abc123',
    })
  })
})

/** Thirty minutes, the default value of `DEVICE_CODE_TTL`. */
const PAIRING_TTL = 30 * 60_000

describe('DeviceService', () => {
  it('binds a machine to a room and revokes it without touching the account', () => {
    const rooms = new RoomService(db)
    seedRoom(rooms)
    const devices = new DeviceService(db, PAIRING_TTL)

    devices.recordRequest(CLIENT_ID, 'room')
    expect(devices.pending().map((p) => p.clientId)).toEqual([CLIENT_ID])

    devices.bind({ clientId: CLIENT_ID, roomId: TRACK_1, approvedByUserId: 'op-1', label: 'PC régie 1' })
    expect(devices.roomFor(CLIENT_ID)).toBe(TRACK_1)
    // The request leaves the queue once handled.
    expect(devices.pending()).toEqual([])

    devices.revoke(CLIENT_ID)
    expect(devices.roomFor(CLIENT_ID)).toBeNull()
  })

  it('ignores a machine that was never paired', () => {
    expect(new DeviceService(db, PAIRING_TTL).roomFor('01ZZZZZZZZZZZZZZZZZZZZZZZZ')).toBeNull()
  })

  it('forgets a request whose code has expired', () => {
    vi.useFakeTimers()
    try {
      const devices = new DeviceService(db, 60_000)
      devices.recordRequest(CLIENT_ID, 'room:' + TRACK_1)
      expect(devices.pending()).toHaveLength(1)

      // Nothing erased it: a reinstalled machine comes back under a new identity,
      // and the queue kept the old one indefinitely.
      vi.advanceTimersByTime(120_000)
      expect(devices.pending()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('forgets one precise request, without touching the others', () => {
    const devices = new DeviceService(db, PAIRING_TTL)
    devices.recordRequest(CLIENT_ID, undefined)
    devices.recordRequest(OTHER_CLIENT_ID, undefined)

    devices.forget(CLIENT_ID)
    expect(devices.pending().map((p) => p.clientId)).toEqual([OTHER_CLIENT_ID])
  })

  it('filters out `client_id`s outside the ULID format', () => {
    const devices = new DeviceService(db, PAIRING_TTL)
    expect(devices.isKnownClient(CLIENT_ID)).toBe(true)
    expect(devices.isKnownClient('interns-machine')).toBe(false)
  })
})
