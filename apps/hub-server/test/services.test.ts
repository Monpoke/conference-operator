import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openHubDatabase, type HubDatabase } from '../src/db.js'
import { ProgramService } from '../src/services/program.js'
import { CommandService } from '../src/services/commands.js'
import { IngestService } from '../src/services/ingest.js'
import { DeviceService, RoomService } from '../src/services/rooms.js'

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const TRACK_1 = 'track-1-teilhard-de-chardin'
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'
const AUTRE_CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6D'

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
  it('importe, normalise et active un snapshot', () => {
    const programs = new ProgramService(db)
    const snapshot = programs.importFromText(rawProgram, 'https://exemple/programme.json')

    expect(snapshot.program.sessions).toHaveLength(27)
    expect(snapshot.program.rooms).toHaveLength(3)
    expect(programs.active()?.contentHash).toBe(snapshot.contentHash)
  })

  it('ne crée pas de doublon quand la source n\'a pas changé', () => {
    const programs = new ProgramService(db)
    const first = programs.importFromText(rawProgram, 'https://exemple/programme.json')
    const second = programs.importFromText(rawProgram, 'https://exemple/programme.json')

    expect(second.contentHash).toBe(first.contentHash)
    expect(programs.list()).toHaveLength(1)
  })

  it('permet de revenir à un snapshot précédent', () => {
    const programs = new ProgramService(db)
    const original = programs.importFromText(rawProgram, 'https://exemple/programme.json')

    // Un import du jour J qui vide le programme : exactement ce qu'on veut annuler.
    const broken = JSON.parse(rawProgram)
    broken.sessions = []
    const bad = programs.importFromText(JSON.stringify(broken), 'https://exemple/programme.json')
    expect(programs.active()?.contentHash).toBe(bad.contentHash)

    programs.activate(original.contentHash)
    // 27 créneaux à l'export, 38 servis : les onze de plus sont les pauses
    // communes projetées dans les salles qui n'ont rien de prévu à ce
    // moment-là. `active()` sert le programme, pas le fichier importé.
    expect(programs.active()?.program.sessions).toHaveLength(38)
    expect(programs.list()).toHaveLength(2)
  })
})

describe('CommandService', () => {
  it('attribue des `seq` croissants et rejoue le backlog', () => {
    const rooms = new RoomService(db)
    seedRoom(rooms)
    const commands = new CommandService(db)

    const first = commands.publish(TRACK_1, { type: 'scene.force', role: 'HOLD' }, null)
    const second = commands.publish(TRACK_1, { type: 'scene.force', role: 'LIVE' }, null)
    expect(second.seq).toBeGreaterThan(first.seq)

    expect(commands.backlog(TRACK_1, 0).map((c) => c.seq)).toEqual([first.seq, second.seq])
    expect(commands.backlog(TRACK_1, first.seq).map((c) => c.seq)).toEqual([second.seq])
  })

  it('mélange diffusions globales et commandes de salle sans casser l\'ordre', () => {
    const rooms = new RoomService(db)
    seedRoom(rooms)
    seedRoom(rooms, 'track-2')
    const commands = new CommandService(db)

    const forSalle1 = commands.publish(TRACK_1, { type: 'scene.force', role: 'HOLD' }, null)
    const broadcast = commands.publish(
      null,
      { type: 'message.broadcast', text: 'Évacuation', level: 'urgent' },
      600,
    )
    const forSalle2 = commands.publish('track-2', { type: 'scene.force', role: 'LIVE' }, null)

    // C'est ce cas qui impose un `seq` global : la salle 1 voit sa commande puis
    // la diffusion, avec des `seq` strictement croissants — condition pour que
    // la reprise par `lastEventId` ne saute rien.
    const seen = commands.backlog(TRACK_1, 0).map((c) => c.seq)
    expect(seen).toEqual([forSalle1.seq, broadcast.seq])
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
    expect(commands.backlog('track-2', 0).map((c) => c.seq)).toEqual([broadcast.seq, forSalle2.seq])
  })

  it('enchaîne rattrapage puis temps réel dans le même flux', async () => {
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

    // Laisse le rattrapage s'écouler avant de publier en direct.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const live = commands.publish(TRACK_1, { type: 'scene.force', role: 'LIVE' }, null)
    await consumer

    expect(received).toEqual([before.seq, live.seq])
  })

  it('reprend après `sinceSeq` sans redonner ce qui est déjà appliqué', async () => {
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
  it('absorbe un rejeu de lot sans dupliquer', () => {
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

    // Reconnexion : le client rejoue le lot sans savoir s'il est passé.
    const replay = ingest.push(TRACK_1, batch)
    expect(replay.acked).toHaveLength(0)
    expect(replay.duplicates).toHaveLength(2)
  })

  it('recompose les prises depuis les deux bouts remontés par la salle', () => {
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

    // Le hub ne lit pas le disque de la régie : il apparie le démarrage et
    // l'arrêt, et c'est l'arrêt qui porte le fichier écrit.
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
      },
    ])
  })

  it('n\'attribue pas à une instance OBS le fichier de l\'autre', () => {
    const rooms = new RoomService(db)
    seedRoom(rooms)
    const ingest = new IngestService(db)

    // Les deux tournent en même temps sur certaines salles. Apparier dans
    // l'ordre d'arrivée, sans regarder l'instance, donnerait le fichier de B à
    // la prise de A.
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

    const prises = ingest.captations(TRACK_1)
    expect(prises.find((prise) => prise.obs === 'B')).toMatchObject({
      file: '/rushes/depuis-B.mkv',
      enCours: false,
    })
    // A n'a jamais été arrêtée : elle sort ouverte, et sans fichier.
    expect(prises.find((prise) => prise.obs === 'A')).toMatchObject({
      file: null,
      enCours: true,
    })
  })

  it('écarte un événement malformé sans bloquer les autres', () => {
    const rooms = new RoomService(db)
    seedRoom(rooms)
    const ingest = new IngestService(db)

    const outcome = ingest.push(TRACK_1, [
      { id: 'pas-un-ulid', roomId: TRACK_1, seq: 1, payload: { type: 'inconnu' } },
      envelope('01CCCCCCCCCCCCCCCCCCCCCCCC', 2, { type: 'incident', level: 'warn', message: 'ok' }),
    ])

    expect(outcome.rejected).toEqual([{ id: 'pas-un-ulid', reason: 'invalid-schema' }])
    expect(outcome.acked).toEqual(['01CCCCCCCCCCCCCCCCCCCCCCCC'])
  })

  it('refuse un événement estampillé pour une autre salle', () => {
    const rooms = new RoomService(db)
    seedRoom(rooms)
    const outcome = new IngestService(db).push(TRACK_1, [
      envelope('01DDDDDDDDDDDDDDDDDDDDDDDD', 1, { type: 'incident', level: 'warn', message: 'x' }, 'track-2'),
    ])
    expect(outcome.rejected).toEqual([{ id: '01DDDDDDDDDDDDDDDDDDDDDDDD', reason: 'unknown-room' }])
  })

  it('projette les événements sur la vue de supervision', () => {
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

/** Trente minutes, la valeur par défaut de `DEVICE_CODE_TTL`. */
const TTL_APPAIRAGE = 30 * 60_000

describe('DeviceService', () => {
  it('lie une machine à une salle et la révoque sans toucher au compte', () => {
    const rooms = new RoomService(db)
    seedRoom(rooms)
    const devices = new DeviceService(db, TTL_APPAIRAGE)

    devices.recordRequest(CLIENT_ID, 'room')
    expect(devices.pending().map((p) => p.clientId)).toEqual([CLIENT_ID])

    devices.bind({ clientId: CLIENT_ID, roomId: TRACK_1, approvedByUserId: 'op-1', label: 'PC régie 1' })
    expect(devices.roomFor(CLIENT_ID)).toBe(TRACK_1)
    // La demande sort de la file une fois traitée.
    expect(devices.pending()).toEqual([])

    devices.revoke(CLIENT_ID)
    expect(devices.roomFor(CLIENT_ID)).toBeNull()
  })

  it('ignore une machine jamais appairée', () => {
    expect(new DeviceService(db, TTL_APPAIRAGE).roomFor('01ZZZZZZZZZZZZZZZZZZZZZZZZ')).toBeNull()
  })

  it('oublie une demande dont le code a expiré', () => {
    vi.useFakeTimers()
    try {
      const devices = new DeviceService(db, 60_000)
      devices.recordRequest(CLIENT_ID, 'room:' + TRACK_1)
      expect(devices.pending()).toHaveLength(1)

      // Rien ne l'effaçait : une machine réinstallée revient sous une nouvelle
      // identité, et la file gardait l'ancienne indéfiniment.
      vi.advanceTimersByTime(120_000)
      expect(devices.pending()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('oublie une demande précise, sans toucher aux autres', () => {
    const devices = new DeviceService(db, TTL_APPAIRAGE)
    devices.recordRequest(CLIENT_ID, undefined)
    devices.recordRequest(AUTRE_CLIENT_ID, undefined)

    devices.forget(CLIENT_ID)
    expect(devices.pending().map((p) => p.clientId)).toEqual([AUTRE_CLIENT_ID])
  })

  it('filtre les `client_id` hors format ULID', () => {
    const devices = new DeviceService(db, TTL_APPAIRAGE)
    expect(devices.isKnownClient(CLIENT_ID)).toBe(true)
    expect(devices.isKnownClient('machine-du-stagiaire')).toBe(false)
  })
})
