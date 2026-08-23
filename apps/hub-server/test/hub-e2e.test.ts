import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { createORPCClient } from '@orpc/client'
import { RPCLink as FetchLink } from '@orpc/client/fetch'
import { RPCLink as WsLink } from '@orpc/client/websocket'
import type { ContractRouterClient } from '@orpc/contract'
import { contract, type Command } from '@cloudnord/contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHub, type Hub } from '../src/server.js'
import { provisionOperator } from '../src/operators.js'

type Client = ContractRouterClient<typeof contract>

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'motdepasse-regie-2026' }
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'
const TRACK_1 = 'track-1-teilhard-de-chardin'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let hub: Hub
let origin: string
let sockets: WebSocket[] = []

beforeEach(async () => {
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
  const port = typeof address === 'object' && address != null ? address.port : 0
  origin = `http://127.0.0.1:${port}`

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
    displayPort: 7788,
    recordingRoot: null,
  })
})

afterEach(async () => {
  for (const socket of sockets) socket.terminate()
  sockets = []
  await hub.close()
})

/** Client oRPC en HTTP, tel que l'utilise hub-admin. */
function httpClient(headers: Record<string, string> = {}): Client {
  return createORPCClient(
    new FetchLink({
      origin,
      url: '/rpc',
      headers: () => headers,
    }),
  )
}

/** Client oRPC en WebSocket, tel que l'utilise une machine de salle. */
function wsClient(headers: Record<string, string>): Client {
  return createORPCClient(
    new WsLink({
      connect: () => {
        const socket = new WebSocket(`${origin.replace('http', 'ws')}/ws`, { headers })
        sockets.push(socket)
        socket.on('error', () => {})
        return socket as unknown as globalThis.WebSocket
      },
      reconnect: { enabled: true, delay: () => 50, maxAttempt: 5 },
    }),
  )
}

async function signInOperator(): Promise<string> {
  const response = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
  })
  expect(response.ok).toBe(true)
  const body = (await response.json()) as { token: string }
  return body.token
}

/** Déroule l'appairage complet et renvoie les en-têtes de la machine. */
async function pairRoomDevice(): Promise<Record<string, string>> {
  const codeResponse = await fetch(`${origin}/api/auth/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  })
  const request = (await codeResponse.json()) as { device_code: string; user_code: string }

  const operatorToken = await signInOperator()
  const admin = httpClient({ authorization: `Bearer ${operatorToken}` })
  await admin.devices.approve({
    userCode: request.user_code,
    clientId: CLIENT_ID,
    roomId: TRACK_1,
    label: 'PC régie salle 1',
  })

  // Respecte l'intervalle de polling imposé par le hub (RFC 8628 §3.5).
  await sleep(1_100)
  const tokenResponse = await fetch(`${origin}/api/auth/device/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: request.device_code,
      client_id: CLIENT_ID,
    }),
  })
  const granted = (await tokenResponse.json()) as { access_token: string }
  expect(granted.access_token).toBeTruthy()

  /**
   * Échange contre un jeton de salle.
   *
   * La session d'approbation porte les droits de l'opérateur ; une machine de
   * régie n'a aucune raison de les conserver. Elle ne sert qu'à réclamer son
   * propre jeton, à droits réduits.
   */
  const machine = httpClient({
    authorization: `Bearer ${granted.access_token}`,
    'x-room-client-id': CLIENT_ID,
  })
  const { token } = await machine.devices.claim()
  expect(token.startsWith('rt_')).toBe(true)

  return { authorization: `Bearer ${token}` }
}

describe('hub de bout en bout', () => {
  it('répond au health check', async () => {
    const response = await fetch(`${origin}/health`)
    expect(response.ok).toBe(true)
    expect((await response.json()) as { ok: boolean }).toMatchObject({ ok: true })
  })

  it('refuse toute procédure de salle sans appairage', async () => {
    const anonymous = httpClient()
    await expect(anonymous.rooms.sync({ since: null })).rejects.toBeDefined()
  })

  it('appaire une machine puis lui sert le programme de sa salle', async () => {
    const deviceHeaders = await pairRoomDevice()
    const room = wsClient(deviceHeaders)

    const sync = await room.rooms.sync({ since: null })
    expect(sync.room.id).toBe(TRACK_1)
    expect(sync.program?.sessions).toHaveLength(27)
    expect(sync.serverTime).toBeTruthy()

    // Deuxième sync avec le même hash : le snapshot n'est pas renvoyé.
    const again = await room.rooms.sync({ since: sync.contentHash })
    expect(again.program).toBeNull()
    expect(again.contentHash).toBe(sync.contentHash)
  }, 20_000)

  it('descend à la salle le nom de l\'événement et le projet OpenFeedback', async () => {
    // La salle titre ses fenêtres et dessine ses QR avec ce que le hub a
    // tranché, jamais avec une constante compilée dans le binaire installé sur
    // la machine — c'est la même machine qui servira l'édition suivante.
    hub.services.settings.update({ openFeedbackProjectId: 'cloud-nord-2026' })
    const room = wsClient(await pairRoomDevice())

    const sync = await room.rooms.sync({ since: null })

    expect(sync.event).toEqual({ name: 'Cloud Nord 2026', shortName: 'Cloud Nord' })
    // Résolu par le hub : la salle n'a pas à connaître la règle de priorité
    // entre le réglage de l'événement et sa propre surcharge.
    expect(sync.room.openFeedbackProjectId).toBe('cloud-nord-2026')
  }, 20_000)

  it('laisse une salle surcharger le projet OpenFeedback de l\'événement', async () => {
    // Ce qui se découvre devant la machine gagne : une salle peut devoir
    // pointer ailleurs, et ça ne se décide pas depuis la console.
    hub.services.settings.update({ openFeedbackProjectId: 'cloud-nord-2026' })
    const salle = hub.services.rooms.get(TRACK_1)!
    hub.services.rooms.upsert({ ...salle, openFeedbackProjectId: 'atelier-2026' })
    const room = wsClient(await pairRoomDevice())

    const sync = await room.rooms.sync({ since: null })

    expect(sync.room.openFeedbackProjectId).toBe('atelier-2026')
  }, 20_000)

  it('achemine les commandes descendantes et remonte les événements', async () => {
    const deviceHeaders = await pairRoomDevice()
    const room = wsClient(deviceHeaders)

    const received: Command[] = []
    const iterator = await room.rooms.commands()
    const consumer = (async () => {
      for await (const command of iterator) {
        received.push(command)
        if (received.length === 2) break
      }
    })()

    await sleep(50)
    hub.services.commands.publish(TRACK_1, { type: 'scene.force', role: 'HOLD' }, null)
    hub.services.commands.publish(
      null,
      { type: 'message.broadcast', text: 'Ouverture des portes', level: 'info' },
      600,
    )
    await consumer

    expect(received.map((c) => c.payload.type)).toEqual(['scene.force', 'message.broadcast'])
    expect(received[1]!.seq).toBeGreaterThan(received[0]!.seq)

    // Remontée de l'outbox, puis rejeu du même lot.
    const batch = [
      {
        id: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        roomId: TRACK_1,
        seq: 1,
        occurredAt: '2026-10-30T09:00:00.000+00:00',
        monotonicMs: 1000,
        delivery: 'required' as const,
        payload: { type: 'recording.started' as const, obs: 'B' as const, sessionId: 'ses-1' },
      },
    ]
    const first = await room.ingest.push({ batch })
    expect(first.acked).toEqual(['01AAAAAAAAAAAAAAAAAAAAAAAA'])
    const replay = await room.ingest.push({ batch })
    expect(replay.acked).toEqual([])
    expect(replay.duplicates).toEqual(['01AAAAAAAAAAAAAAAAAAAAAAAA'])
  }, 20_000)

  it('révoque une machine : son jeton ne donne plus accès à la salle', async () => {
    const deviceHeaders = await pairRoomDevice()
    const room = httpClient(deviceHeaders)
    await expect(room.rooms.sync({ since: null })).resolves.toBeDefined()

    hub.services.devices.revoke(CLIENT_ID)
    await expect(room.rooms.sync({ since: null })).rejects.toBeDefined()
  }, 20_000)
})


/**
 * Supervision : ce qui se joue dans chaque salle, et pour combien de temps.
 *
 * Le restant est calculé par le hub et non par la console : celle-ci n'a que
 * l'horloge du poste, qui n'est pas celle qui fait foi — et qui peut en être
 * à des semaines quand le hub tourne sur une heure simulée.
 */
describe('temps restant des salles', () => {
  it('le compte sur l\'horloge du hub, pas sur celle du client', async () => {
    hub.services.clock.setSimulated('2026-10-30T10:20:00.000Z')
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    const salles = await admin.rooms.statuses()
    const salle = salles.find((s) => s.roomId === TRACK_1)
    const creneau = salle?.currentSession
    expect(creneau?.title).toEqual(expect.any(String))
    expect(creneau?.endsAt).toEqual(expect.any(String))

    // Référencé sur l'heure simulée : la machine qui fait tourner ce test est
    // à une tout autre date, et un calcul fait chez elle serait aberrant.
    const attendu = Date.parse(creneau!.endsAt!) - Date.parse('2026-10-30T10:20:00.000Z')
    expect(Math.abs(creneau!.remainingMs! - attendu)).toBeLessThan(2_000)
  })

  it('ne l\'invente pas quand rien ne se joue', async () => {
    // Heure réelle : l'événement est en octobre, il n'y a pas de créneau en cours.
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const salles = await admin.rooms.statuses()

    expect(salles.find((s) => s.roomId === TRACK_1)?.currentSession).toBeNull()
  })
})

/**
 * Resynchronisation demandée depuis la console.
 *
 * Elle existe parce qu'il n'y avait pas d'autre recours : remettre une salle
 * d'aplomb demandait de la redémarrer, donc de couper sa captation.
 */
describe('resynchronisation des salles', () => {
  it('descend la demande à la salle visée', async () => {
    const headers = await pairRoomDevice()
    const salle = wsClient(headers)
    const recues: Command[] = []
    const flux = (async () => {
      for await (const commande of await salle.rooms.commands()) {
        recues.push(commande)
        if (recues.length >= 1) break
      }
    })()

    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    await sleep(200)
    const resultat = await admin.rooms.resync({ roomId: TRACK_1 })
    expect(resultat).toEqual({ ok: true, rooms: 1 })

    await Promise.race([flux, sleep(3_000)])
    expect(recues[0]?.payload).toMatchObject({
      type: 'room.resync',
      // Qui l'a demandée : la salle le trace, on saura d'où vient le geste.
      requestedBy: OPERATOR.email,
    })
  })

  it('compte les salles visées quand la demande est générale', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    // Une seule salle sur ce hub : c'est le compte qu'annonce la console, et
    // c'est ce qui lui permet de dire « aucune salle » plutôt que « c'est parti »
    // sur un hub où rien n'est appairé.
    expect(await admin.rooms.resync({ roomId: null })).toEqual({ ok: true, rooms: 1 })
  })

  it('refuse une salle inconnue plutôt que d\'émettre dans le vide', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    await expect(admin.rooms.resync({ roomId: 'salle-fantome' })).rejects.toThrow(/inconnue/)
  })

  it('reste fermée aux salles : c\'est un geste de console', async () => {
    const headers = await pairRoomDevice()
    const salle = wsClient(headers)

    await expect(salle.rooms.resync({ roomId: TRACK_1 })).rejects.toThrow()
  })
})

/**
 * Planning relu depuis la console.
 *
 * Le tableau des conférences ne montre que ce qui a été démarré : il répond à
 * « où en est-on », jamais à « et après, il y a quoi ». Le lien OpenFeedback
 * accompagne chaque créneau — c'est l'adresse qu'on redonne au speaker venu
 * demander où sont ses retours.
 */
describe('planning du programme actif', () => {
  it('rend le programme entier, salles et horaires résolus', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    const planning = await admin.program.planning()

    expect(planning.contentHash).toEqual(expect.any(String))
    expect(planning.timezone).toBe('Europe/Paris')
    expect(planning.rooms.map((salle) => salle.id)).toContain(TRACK_1)
    // 27 créneaux à l'export : la console les montre tous, pas seulement les
    // deux ou trois qui ont été lancés.
    expect(planning.sessions).toHaveLength(27)
    // Le nom du hub l'emporte sur celui du programme : une salle se renomme
    // depuis la console, et c'est ce nom-là qui est écrit sur la porte.
    expect(planning.sessions.find((s) => s.roomId === TRACK_1)?.roomName).toBe(
      'Track #1 - Teilhard de Chardin',
    )
  })

  it('ne propose rien à noter tant que le projet OpenFeedback n\'est pas réglé', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    const planning = await admin.program.planning()

    // Pas de projet en dur : le dépôt ne connaît pas l'événement qu'il sert, et
    // un lien vers le projet d'un autre organisateur serait pire que rien —
    // scanné en salle, il mène à une page qui ne parle pas de ce talk.
    expect(planning.sessions.every((session) => session.feedbackUrl == null)).toBe(true)
  })

  it('donne le lien OpenFeedback de chaque conférence', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    // Réglage du hub : le projet est une propriété de l'événement, pas d'une
    // salle. Le régler une fois vaut pour toutes, créneaux sans salle compris.
    await admin.settings.update({ openFeedbackProjectId: 'cloud-nord-2026' })

    const planning = await admin.program.planning()
    const talk = planning.sessions.find((session) => session.kind === 'talk')!

    // Route publique d'OpenFeedback, fabriquée depuis le programme : aucun
    // appel réseau, aucune clé d'API, et donc rien à réparer le jour J.
    expect(talk.feedbackUrl).toBe(
      `https://openfeedback.io/cloud-nord-2026/2026-10-30/${talk.id}`,
    )
  })

  it('ne propose rien à noter sur une pause', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    const planning = await admin.program.planning()
    const pause = planning.sessions.find((session) => session.kind === 'break')

    // Personne ne note un déjeuner, et un QR mort coûte plus cher qu'une case
    // vide.
    expect(pause).toBeTruthy()
    expect(pause?.feedbackUrl).toBeNull()
  })

  it('date le planning sur l\'horloge du hub, pas sur celle de la console', async () => {
    // C'est cette heure-là qui désigne le créneau surligné « en ce moment ».
    // Calculée dans le navigateur, elle pointerait un créneau d'une tout autre
    // semaine dès que le hub tourne sur une heure simulée.
    hub.services.clock.setSimulated('2026-10-30T10:20:00.000Z')
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    const planning = await admin.program.planning()

    expect(
      Math.abs(Date.parse(planning.serverTime) - Date.parse('2026-10-30T10:20:00.000Z')),
    ).toBeLessThan(2_000)
  })

  it('reste fermé aux machines de salle', async () => {
    // Le planning est déjà poussé aux salles par le sync : leur ouvrir en plus
    // une procédure d'opérateur n'ajouterait que de la surface.
    const machine = httpClient(await pairRoomDevice())

    await expect(machine.program.planning()).rejects.toThrow()
  })
})
