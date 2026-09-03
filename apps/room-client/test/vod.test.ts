import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHub, type Hub } from '@cloudnord/hub-server/server'
import { provisionOperator } from '@cloudnord/hub-server/operators'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { contract } from '@cloudnord/contract'
import { RoomApp } from '../src/core/room-app.js'
import type { ObsTransport } from '../src/core/obs.js'
import type { Sidecar } from '../src/core/recording.js'

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'motdepasse-regie-2026' }
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'
const TRACK_1 = 'track-1-teilhard-de-chardin'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * OBS factice à deux instances.
 *
 * Reproduit le comportement qui compte pour la VOD : `SetProfileParameter` est
 * accepté ou refusé selon le scénario, et `StopRecord` annonce le chemin de
 * sortie par événement — comme le vrai OBS.
 */
function fakeObsPair(recDir: string, options: { honorFilenameFormat?: boolean } = {}) {
  const honor = options.honorFilenameFormat ?? true
  let format = 'brut'
  const instances: { scenes: string[]; handlers: Map<string, ((p: unknown) => void)[]> }[] = []

  const make = (scenes: string[]): ObsTransport => {
    const handlers = new Map<string, ((p: unknown) => void)[]>()
    instances.push({ scenes, handlers })
    const emit = (event: string, payload: unknown) => {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    }

    return {
      connect: async () => {},
      disconnect: async () => {},
      call: (async (request: string, args?: Record<string, unknown>) => {
        switch (request) {
          case 'GetSceneList':
            return {
              currentProgramSceneName: scenes[0],
              scenes: scenes.map((sceneName) => ({ sceneName })),
            }
          case 'SetProfileParameter':
            if (!honor) throw new Error('paramètre inconnu')
            format = String(args!.parameterValue)
            return {}
          case 'StartRecord':
            emit('RecordStateChanged', { outputActive: true })
            return {}
          case 'StopRecord': {
            // OBS écrit le fichier, puis annonce son chemin.
            const chemin = join(recDir, `${honor ? format : '2026-10-30 12-00-00'}.mkv`)
            writeFileSync(chemin, 'FAUX-MKV')
            emit('RecordStateChanged', { outputActive: false, outputPath: chemin })
            return {}
          }
          default:
            return {}
        }
      }) as ObsTransport['call'],
      on: (event, handler) => {
        const list = handlers.get(event) ?? []
        list.push(handler as (p: unknown) => void)
        handlers.set(event, list)
      },
    }
  }

  // L'instance est explicite : plus de dépendance à l'ordre d'appel.
  return (instance: 'A' | 'B') =>
    instance === 'A' ? make(['Capture HDMI', 'Habillage']) : make(['Talk', 'Caméra seule'])
}

let hub: Hub
let origin: string
let dir: string
let recDir: string
let room: RoomApp | null = null

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-vod-'))
  recDir = join(dir, 'rec')
  mkdirSync(recDir, { recursive: true })

  hub = await createHub({
    port: 0,
    host: '127.0.0.1',
    databasePath: ':memory:',
    publicUrl: 'http://127.0.0.1',
    authSecret: 'test-secret-'.padEnd(48, 'x'),
    logLevel: 'fatal',
    devicePollInterval: '1s',
  })
  await hub.app.listen({ port: 0, host: '127.0.0.1' })
  const address = hub.app.server.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`

  await provisionOperator(hub.auth, OPERATOR)
  hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
  hub.services.rooms.upsert({
    id: TRACK_1,
    name: 'Track #1 - Teilhard de Chardin',
    trackId: TRACK_1,
    obs: {
      A: { url: 'ws://127.0.0.1:4455', password: null },
      B: { url: 'ws://127.0.0.1:4456', password: null },
    },
    sceneRoles: { A: { LIVE: 'Capture HDMI', HOLD: 'Habillage' }, B: { TALK: 'Talk', CAM_ONLY: 'Caméra seule' } },
    fileSlug: 'track1',
    recordingRoot: recDir,
  })
})

afterEach(async () => {
  await room?.close()
  room = null
  await hub.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

async function bootRoom(obsFactory: (instance: 'A' | 'B') => ObsTransport): Promise<RoomApp> {
  let token: string | null = null
  const app = new RoomApp({
    dataDir: dir,
    hubOrigin: origin,
    clientId: CLIENT_ID,
    // Salle connue d'avance : ces tests n'ont pas d'écran pour la choisir.
    roomId: TRACK_1,
    displayPort: 0,
    obsTransportFactory: obsFactory,
    readToken: () => token,
    writeToken: (value) => {
      token = value
    },
    onPairingCode: (code) => {
      void (async () => {
        const response = await fetch(`${origin}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
        })
        const session = (await response.json()) as { token: string }
        const admin: ContractRouterClient<typeof contract> = createORPCClient(
          new RPCLink({
            origin,
            url: '/rpc',
            headers: () => ({ authorization: `Bearer ${session.token}` }),
          }),
        )
        await admin.devices.approve({
          userCode: code.user_code,
          clientId: CLIENT_ID,
          roomId: TRACK_1,
          label: 'PC régie salle 1',
        })
      })()
    },
  })

  await app.startDisplay()
  const token2 = await app.ensurePaired()
  await app.connectHub(token2!)
  await app.connectObs()
  // Le programme place la timeline sur un talk pour que le sidecar soit renseigné.
  app.runtime.setClockOffset(Date.parse('2026-10-30T10:20:00.000Z') - Date.now())
  app.runtime.refreshSessions()
  return app
}

describe('chaîne VOD', () => {
  it('produit un master nommé et son sidecar', async () => {
    room = await bootRoom(fakeObsPair(recDir))

    await room.startRecording()
    room.mark('début de la démo')
    await sleep(50)
    room.mark('questions')
    const result = await room.stopRecording()

    // Le master porte un nom triable et lisible sans l'ouvrir.
    expect(result.videoPath).toContain('2026-10-30_track1_1100_honeyswamp')
    expect(result.sidecarPath).toMatch(/\.json$/)

    const sidecar = JSON.parse(readFileSync(result.sidecarPath!, 'utf8')) as Sidecar
    expect(sidecar.title).toContain('HoneySwamp')
    expect(sidecar.speakers.length).toBeGreaterThan(0)
    expect(sidecar.markers.map((m) => m.label)).toEqual(['début de la démo', 'questions'])
    expect(sidecar.videoFile).toMatch(/^2026-10-30_track1_1100_honeyswamp.*\.mkv$/)
    expect(sidecar.category).toBeTruthy()
  }, 40_000)

  it('répare le nom quand OBS ignore le format', async () => {
    room = await bootRoom(fakeObsPair(recDir, { honorFilenameFormat: false }))

    await room.startRecording()
    const result = await room.stopRecording()

    // Filet de sécurité : le chemin annoncé par OBS fait foi, on renomme.
    expect(result.videoPath).toContain('2026-10-30_track1_1100_honeyswamp')
    const fichiers = readdirSync(recDir)
    expect(fichiers.some((f) => f.startsWith('2026-10-30 12-00-00'))).toBe(false)
    expect(fichiers.filter((f) => f.endsWith('.json'))).toHaveLength(1)
  }, 40_000)

  it('remonte le cycle d\'enregistrement au hub, dans l\'ordre', async () => {
    room = await bootRoom(fakeObsPair(recDir))

    await room.startRecording()
    room.mark('démo')
    await room.stopRecording()
    await sleep(3_000)

    const types = hub.services.ingest.eventsFor(TRACK_1).map((e) => e.type)
    const debut = types.indexOf('recording.started')
    const marqueur = types.indexOf('talk.marker')
    const fin = types.indexOf('recording.stopped')

    expect(debut).toBeGreaterThanOrEqual(0)
    // L'ordre est ce qui rend les timecodes exploitables au editing.
    expect(marqueur).toBeGreaterThan(debut)
    expect(fin).toBeGreaterThan(marqueur)
  }, 40_000)

  it('refuse un marqueur hors enregistrement plutôt que de l\'ignorer', async () => {
    room = await bootRoom(fakeObsPair(recDir))
    expect(() => room!.mark('perdu')).toThrow(/Aucun enregistrement/)
  }, 40_000)

  it('refuse de diffuser sans clé fournie par le hub', async () => {
    room = await bootRoom(fakeObsPair(recDir))
    await expect(room.startStreaming()).rejects.toThrow(/clé de diffusion/)
  }, 40_000)
})
