import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import type { DisplayPayload } from '../src/core/display-server.js'

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'motdepasse-regie-2026' }
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'
const TRACK_1 = 'track-1-teilhard-de-chardin'

function fakeObsPair(recDir: string) {
  let appel = 0
  const make = (scenes: string[]): ObsTransport => {
    const handlers = new Map<string, ((p: unknown) => void)[]>()
    let current = scenes[1] ?? scenes[0]!
    const emit = (event: string, payload: unknown) => {
      for (const h of handlers.get(event) ?? []) h(payload)
    }
    return {
      connect: async () => {},
      disconnect: async () => {},
      call: (async (request: string, args?: Record<string, unknown>) => {
        if (request === 'GetSceneList') {
          return { currentProgramSceneName: current, scenes: scenes.map((sceneName) => ({ sceneName })) }
        }
        if (request === 'SetCurrentProgramScene') {
          current = args!.sceneName as string
          emit('CurrentProgramSceneChanged', { sceneName: current })
        }
        if (request === 'StartRecord') emit('RecordStateChanged', { outputActive: true })
        if (request === 'StopRecord') {
          const chemin = join(recDir, 'sortie.mkv')
          writeFileSync(chemin, 'FAUX')
          emit('RecordStateChanged', { outputActive: false, outputPath: chemin })
        }
        return {}
      }) as ObsTransport['call'],
      on: (event, handler) => {
        const list = handlers.get(event) ?? []
        list.push(handler as (p: unknown) => void)
        handlers.set(event, list)
      },
    }
  }
  return () => {
    appel += 1
    return appel === 1 ? make(['Capture HDMI', 'Habillage']) : make(['Talk'])
  }
}

let hub: Hub
let origin: string
let dir: string
let room: RoomApp
let regie: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-regie-'))
  const recDir = join(dir, 'rec')
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
    sceneRoles: { A: { LIVE: 'Capture HDMI', HOLD: 'Habillage' }, B: { TALK: 'Talk' } },
    fileSlug: 'track1',
    recordingRoot: recDir,
  })

  let token: string | null = null
  room = new RoomApp({
    dataDir: dir,
    hubOrigin: origin,
    clientId: CLIENT_ID,
    // Salle connue d'avance : ces tests n'ont pas d'écran pour la choisir.
    roomId: TRACK_1,
    displayPort: 0,
    obsTransportFactory: fakeObsPair(recDir),
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
          new RPCLink({ origin, url: '/rpc', headers: () => ({ authorization: `Bearer ${session.token}` }) }),
        )
        await admin.devices.approve({ userCode: code.user_code, clientId: CLIENT_ID, roomId: TRACK_1 })
      })()
    },
  })

  regie = await room.startDisplay()
  const jeton = await room.ensurePaired()
  await room.connectHub(jeton!)
  await room.connectObs()
  room.runtime.setClockOffset(Date.parse('2026-10-30T10:20:00.000Z') - Date.now())
  room.runtime.refreshSessions()
})

afterEach(async () => {
  await room.close()
  await hub.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

const agir = async (payload: unknown) => {
  const response = await fetch(`${regie}/control/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: (await response.json()) as { ok: boolean; message?: string } }
}

const etat = async () => (await (await fetch(`${regie}/display/data`)).json()) as DisplayPayload

describe('fenêtre de régie', () => {
  it('sert une page autonome, sans étape de build', async () => {
    const html = await (await fetch(`${regie}/regie`)).text()
    expect(html).toContain('Régie — Cloud Nord')
    // Une dépendance externe casserait la régie dès la première coupure.
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/)
  }, 40_000)

  it('bascule l\'écran de salle', async () => {
    const resultat = await agir({ action: 'display.set', mode: 'programme' })
    expect(resultat.body.ok).toBe(true)
    expect((await etat()).state.mode).toBe('programme')
  }, 40_000)

  it('bascule la scène de projection sur OBS', async () => {
    await agir({ action: 'scene.set', role: 'LIVE' })
    expect((await etat()).state.sceneRole).toBe('LIVE')
  }, 40_000)

  it('déroule un enregistrement complet', async () => {
    expect((await etat()).diagnostics?.recording.active).toBe(false)

    expect((await agir({ action: 'recording.start' })).body.ok).toBe(true)
    const enCours = await etat()
    expect(enCours.diagnostics?.recording.active).toBe(true)
    expect(enCours.diagnostics?.recording.startedAtMs).toBeGreaterThan(0)

    await agir({ action: 'recording.mark', label: 'démo' })
    expect((await etat()).diagnostics?.recording.markers).toBe(1)

    const arret = await agir({ action: 'recording.stop' })
    expect(arret.body.message).toContain('.mkv')
    expect((await etat()).diagnostics?.recording.active).toBe(false)
  }, 40_000)

  it('renvoie un message lisible plutôt qu\'une page cassée', async () => {
    // Marqueur hors enregistrement : erreur attendue, formulée pour l'opérateur.
    const resultat = await agir({ action: 'recording.mark', label: 'perdu' })
    expect(resultat.status).toBe(409)
    expect(resultat.body.ok).toBe(false)
    expect(resultat.body.message).toContain('Aucun enregistrement')
  }, 40_000)

  it('refuse une action inconnue', async () => {
    expect((await agir({ action: 'formatage.disque' })).status).toBe(400)
    // Un rôle de scène inexistant est rejeté avant d'atteindre OBS.
    expect((await agir({ action: 'scene.set', role: 'INVENTEE' })).status).toBe(400)
  }, 40_000)

  it('expose l\'état des deux instances OBS', async () => {
    const diagnostics = (await etat()).diagnostics
    expect(diagnostics?.obs.A?.connected).toBe(true)
    expect(diagnostics?.obs.B?.connected).toBe(true)
    // Le mapping de rôles de cette salle est complet des deux côtés.
    expect(diagnostics?.obs.A?.unresolvedRoles).toEqual([])
  }, 40_000)

  it('remonte la profondeur de file et le journal', async () => {
    const diagnostics = (await etat()).diagnostics
    expect(diagnostics?.outboxDepth).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(diagnostics?.journal)).toBe(true)
  }, 40_000)
})
