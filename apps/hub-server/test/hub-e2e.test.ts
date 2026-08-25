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
    // 27 créneaux à l'export, 38 servis : les pauses communes sont projetées
    // dans les salles libres au même moment, et la salle les reçoit comme les
    // siennes — c'est ce qui lui évite un trou pendant le déjeuner.
    expect(sync.program?.sessions).toHaveLength(38)
    expect(sync.program?.sessions.filter((s) => s.sharedFrom != null)).toHaveLength(11)
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

  it('ne laisse plus une salle contredire le projet OpenFeedback de l\'événement', async () => {
    // Le projet est une propriété de l'événement, et un seul endroit l'écrit.
    // Tant que la régie le pouvait aussi, il a suffi qu'un opérateur le
    // remplisse sur une machine pour que cette salle-là ait des liens et pas
    // les autres — sans que rien ne dise pourquoi.
    hub.services.settings.update({ openFeedbackProjectId: 'cloud-nord-2026' })
    const salle = hub.services.rooms.get(TRACK_1)!
    hub.services.rooms.upsert({ ...salle, openFeedbackProjectId: 'atelier-2026' })
    const room = wsClient(await pairRoomDevice())

    const sync = await room.rooms.sync({ since: null })

    // Écrasé, pas complété : ce que la salle porte en base ne pèse rien.
    expect(sync.room.openFeedbackProjectId).toBe('cloud-nord-2026')
  }, 20_000)

  it('refuse à une salle d\'écrire le projet OpenFeedback', async () => {
    // La procédure de configuration existe toujours — les adresses OBS et les
    // noms de scènes se constatent devant les machines — mais ce champ-là en
    // est sorti : zod écarte les clés inconnues, la salle ne peut plus rien
    // poser dessus.
    hub.services.settings.update({ openFeedbackProjectId: 'cloud-nord-2026' })
    const room = wsClient(await pairRoomDevice())

    const config = await room.rooms.configure({
      openFeedbackProjectId: 'atelier-2026',
      displayPort: 7799,
    } as never)

    // Le reste du patch passe : c'est un champ ignoré, pas un appel refusé.
    expect(config.displayPort).toBe(7799)
    expect(hub.services.rooms.get(TRACK_1)?.openFeedbackProjectId).toBeNull()
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
 * Créneaux dont le genre se corrige depuis la console.
 *
 * L'export amont ne distingue pas un déjeuner d'une conférence : les deux sont
 * des créneaux avec un titre et une salle. Le normaliseur tranche sur un seul
 * signal — pas d'intervenant, donc une pause — et se trompe dans les deux sens :
 * la salle titrait « Déjeuner » à l'antenne, et laissait la keynote d'ouverture
 * sans titrage ni bouton « Commencer ».
 */
describe('corriger le genre d\'un créneau', () => {
  /** « IA for OPS on Scaleway », une vraie conférence de Track #1. */
  const TALK = 'cmotqj1r1008401pxxsm6y2fu'

  it('le sert en break partout, empreinte comprise', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const avant = hub.services.programs.active()!

    const resultat = await admin.sessions.override({ sessionId: TALK, action: 'break' })

    expect(resultat.ok).toBe(true)
    // L'empreinte bouge : sans ça, les salles resteraient sur leur cache et
    // continueraient de titrer à l'antenne ce qu'on vient de corriger.
    expect(resultat.contentHash).not.toBe(avant.contentHash)

    const apres = hub.services.programs.active()!
    expect(apres.contentHash).toBe(resultat.contentHash)
    expect(apres.program.sessions.find((s) => s.id === TALK)?.kind).toBe('break')
    // Le reste du programme est intact.
    expect(apres.program.sessions).toHaveLength(avant.program.sessions.length)
  })

  it('le retire du planning comme conférence, et de ses QR de feedback', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    await admin.settings.update({ openFeedbackProjectId: 'cloud-nord-2026' })

    const avant = (await admin.program.planning()).sessions.find((s) => s.id === TALK)!
    expect(avant.kind).toBe('talk')
    expect(avant.feedbackUrl).toEqual(expect.any(String))
    expect(avant.overriddenAs).toBeNull()

    await admin.sessions.override({ sessionId: TALK, action: 'break' })

    const apres = (await admin.program.planning()).sessions.find((s) => s.id === TALK)!
    expect(apres.kind).toBe('break')
    // La console est seule à distinguer un break de l'export d'un break décidé :
    // c'est elle qui l'a posé, et c'est chez elle qu'on le retire.
    expect(apres.overriddenAs).toBe('break')
    // Plus rien à noter : un QR mort scanné par le public coûte plus cher
    // qu'une case vide.
    expect(apres.feedbackUrl).toBeNull()
  })

  it('change ce que la pastille de la salle raconte', async () => {
    hub.services.clock.setSimulated('2026-10-30T09:00:00.000Z')
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    // 09:00 UTC : « IA for OPS » court de 08:50 à 09:40, personne ne l'a lancée.
    const avant = await admin.rooms.statuses()
    expect(avant.find((s) => s.roomId === TRACK_1)?.conference).toBe('retard')

    await admin.sessions.override({ sessionId: TALK, action: 'break' })

    // Un créneau qui n'est pas une conférence ne se démarre pas : il n'y a plus
    // de retard au démarrage à signaler.
    const apres = await admin.rooms.statuses()
    expect(apres.find((s) => s.roomId === TRACK_1)?.conference).toBe('pause')
  })

  it('se retire, et rend au programme son empreinte d\'origine', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const origine = hub.services.programs.active()!.contentHash

    await admin.sessions.override({ sessionId: TALK, action: 'break' })
    const retire = await admin.sessions.override({ sessionId: TALK, action: null })

    // Retirée, la surcharge doit être indistinguable d'une surcharge jamais
    // posée : sinon les salles retéléchargeraient pour rien à chaque aller-retour.
    expect(retire.contentHash).toBe(origine)
    expect(hub.services.programs.active()!.program.sessions.find((s) => s.id === TALK)?.kind)
      .toBe('talk')
  })

  it('prévient les salles, programme corrigé à l\'appui', async () => {
    const headers = await pairRoomDevice()
    const salle = wsClient(headers)
    const recues: Command[] = []
    const flux = (async () => {
      for await (const commande of await salle.rooms.commands()) {
        recues.push(commande)
        break
      }
    })()

    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    await sleep(200)
    const { contentHash } = await admin.sessions.override({ sessionId: TALK, action: 'break' })

    await Promise.race([flux, sleep(3_000)])
    expect(recues[0]?.payload).toMatchObject({ type: 'program.invalidate', contentHash })

    // Et la salle qui resynchronise sur son ancienne empreinte reçoit bien le
    // programme corrigé, pas un `null` « rien n'a changé ».
    const resultat = await salle.rooms.sync({ since: null })
    expect(resultat.contentHash).toBe(contentHash)
    expect(resultat.program?.sessions.find((s) => s.id === TALK)?.kind).toBe('break')
  })

  /** « Keynote d'ouverture » : sans speaker annoncé, l'export la donne en pause. */
  const KEYNOTE = 'SCGAR8iJEoCyZxxLyfbb'

  it("rend conférence un créneau que l'export donne pour une pause", async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    await admin.settings.update({ openFeedbackProjectId: 'cloud-nord-2026' })

    // Le normaliseur n'a qu'un signal pour trancher — pas d'intervenant, donc
    // une pause — et la keynote d'ouverture est précisément le cas où il rate.
    const avant = (await admin.program.planning()).sessions.find((s) => s.id === KEYNOTE)!
    expect(avant.kind).toBe('break')
    expect(avant.speakers).toEqual([])

    await admin.sessions.override({ sessionId: KEYNOTE, action: 'talk' })

    const apres = (await admin.program.planning()).sessions.find((s) => s.id === KEYNOTE)!
    expect(apres.kind).toBe('talk')
    expect(apres.overriddenAs).toBe('talk')
    // Redevenue une conférence, elle se note : le QR reparaît.
    expect(apres.feedbackUrl).toEqual(expect.any(String))
    expect(hub.services.programs.active()!.program.sessions.find((s) => s.id === KEYNOTE)?.kind)
      .toBe('talk')
  })

  it('la rend pilotable depuis la régie', async () => {
    hub.services.clock.setSimulated('2026-10-30T08:10:00.000Z')
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    // 08:10 UTC : la keynote court de 08:00 à 08:45. Donnée pour une pause,
    // elle ne se démarre pas — la salle est simplement « en pause ».
    const avant = await admin.rooms.statuses()
    expect(avant.find((s) => s.roomId === TRACK_1)?.conference).toBe('pause')

    await admin.sessions.override({ sessionId: KEYNOTE, action: 'talk' })

    // Déclarée conférence, elle attend qu'on la lance — et le dit.
    const apres = await admin.rooms.statuses()
    expect(apres.find((s) => s.roomId === TRACK_1)?.conference).toBe('retard')
  })

  it("ignore une décision qui dit ce que l'export dit déjà", async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const origine = hub.services.programs.active()!.contentHash

    // Déclarer pause ce que l'export donne déjà pour une pause ne change rien —
    // et ne doit donc pas faire retélécharger le programme dans les salles.
    const resultat = await admin.sessions.override({ sessionId: KEYNOTE, action: 'break' })

    expect(resultat.contentHash).toBe(origine)
    expect(hub.services.programs.active()!.overrides).toEqual({})
  })

  it("redevient sans objet le jour où l'export annonce le speaker", async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const origine = hub.services.programs.active()!.contentHash
    await admin.sessions.override({ sessionId: KEYNOTE, action: 'talk' })
    expect(hub.services.programs.active()!.contentHash).not.toBe(origine)

    // Un réimport où la keynote porte enfin un intervenant : le normaliseur en
    // fait une conférence tout seul, et la décision cesse de s'appliquer.
    const corrige = rawProgram.replace(
      '"id":"SCGAR8iJEoCyZxxLyfbb","title":"Keynote d\'ouverture","abstract":null',
      '"id":"SCGAR8iJEoCyZxxLyfbb","title":"Keynote d\'ouverture, avec son intervenant","abstract":null',
    ).replace(
      '"durationMinutes":45,"speakerIds":[],"trackId":"track-1-teilhard-de-chardin"',
      '"durationMinutes":45,"speakerIds":["McrpEiDzIV1NERXgVIG5"],"trackId":"track-1-teilhard-de-chardin"',
    )
    expect(corrige).not.toBe(rawProgram)
    hub.services.programs.importFromText(corrige, 'https://exemple/programme.json')

    const apres = hub.services.programs.active()!
    expect(apres.program.sessions.find((s) => s.id === KEYNOTE)?.kind).toBe('talk')
    // Sans surcharge appliquée : l'empreinte est celle du snapshot, nue.
    expect(apres.overrides).toEqual({})
    expect(apres.contentHash).not.toContain('~')
  })

  it('fait suivre les pauses communes à la décision', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const partagees = () =>
      hub.services.programs.active()!.program.sessions.filter((s) => s.sharedFrom === TALK)

    // « IA for OPS » est une conférence : rien à partager.
    expect(partagees()).toEqual([])

    await admin.sessions.override({ sessionId: TALK, action: 'break' })

    // Déclarée break, elle se projette dans les salles libres au même moment —
    // la projection se recalcule sur le programme servi, décisions comprises.
    // 08:50 → 09:40 : Track #2 tient son propre talk, Hands on son atelier.
    // Personne n'est libre, donc rien ne se projette : la règle ne recouvre pas.
    expect(partagees()).toEqual([])

    // La keynote, elle, tombe pendant que les deux autres salles sont vides.
    await admin.sessions.override({ sessionId: KEYNOTE, action: 'talk' })
    const sansPause = hub.services.programs
      .active()!
      .program.sessions.filter((s) => s.sharedFrom === KEYNOTE)
    // Redevenue conférence, elle cesse d'être partagée.
    expect(sansPause).toEqual([])

    await admin.sessions.override({ sessionId: KEYNOTE, action: null })
    expect(
      hub.services.programs.active()!.program.sessions.filter((s) => s.sharedFrom === KEYNOTE),
    ).toHaveLength(2)
  })

  it("refuse une décision sur une pause héritée, sans la perdre en route", async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const heritee = hub.services.programs
      .active()!
      .program.sessions.find((s) => s.sharedFrom != null)!

    // Elle n'existe pas dans l'export : une décision posée sur son identifiant
    // dérivé n'aurait aucun effet, et on ne saurait pas la retirer.
    await expect(
      admin.sessions.override({ sessionId: heritee.id, action: 'talk' }),
    ).rejects.toThrow(/h\u00e9rit/)
  })

  it('refuse un créneau absent du programme actif', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    await expect(
      admin.sessions.override({ sessionId: 'creneau-fantome', action: 'break' }),
    ).rejects.toThrow(/inconnu/)
  })

  it('reste fermé aux salles : c\'est le programme de l\'événement', async () => {
    const headers = await pairRoomDevice()
    const salle = wsClient(headers)

    await expect(salle.sessions.override({ sessionId: TALK, action: 'break' })).rejects.toThrow()
  })
})

/**
 * Le créneau commun, vu de l'événement et non d'une salle.
 *
 * Une question différente de celle des cartes : elles disent où en est chaque
 * salle, celui-ci dit ce que fait l'événement.
 */
describe('créneau commun du moment', () => {
  it('compte les salles concernées pendant le déjeuner', async () => {
    // 11:40 UTC : le déjeuner court de 11:15 à 12:05 sur Track #1, et les deux
    // autres salles en héritent — elles n'ont rien de prévu à ce moment-là.
    hub.services.clock.setSimulated('2026-10-30T11:40:00.000Z')
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    const commun = await admin.program.globalBreak()

    expect(commun).toMatchObject({ state: 'en-cours', title: 'Déjeuner', rooms: 3 })
    expect(commun?.endsAt).toBe('2026-10-30T12:05:00.000Z')
    // L'heure du hub voyage avec : le navigateur n'a que la sienne, et elle
    // peut être à des semaines de là quand l'horloge est simulée.
    expect(Date.parse(commun!.serverTime)).toBeCloseTo(Date.parse('2026-10-30T11:40:00.000Z'), -4)
  })

  it("l'annonce un quart d'heure avant", async () => {
    hub.services.clock.setSimulated('2026-10-30T11:05:00.000Z')
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    expect(await admin.program.globalBreak()).toMatchObject({
      state: 'a-venir',
      title: 'Déjeuner',
    })
  })

  it('se tait quand rien de commun ne se joue', async () => {
    // 09:00 UTC : les trois salles tiennent chacune leur conférence.
    hub.services.clock.setSimulated('2026-10-30T09:00:00.000Z')
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    expect(await admin.program.globalBreak()).toBeNull()
  })

  it('suit une décision prise depuis la console', async () => {
    // 09:00 UTC : « IA for OPS » court sur Track #1. Déclarée break, elle
    // devient un créneau commun — mais pour elle seule, les deux autres salles
    // ayant leur propre conférence à cette heure-là.
    hub.services.clock.setSimulated('2026-10-30T09:00:00.000Z')
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const talk = hub.services.programs
      .active()!
      .program.sessions.find((s) => s.title.includes('IA for OPS'))!

    await admin.sessions.override({ sessionId: talk.id, action: 'break' })

    expect(await admin.program.globalBreak()).toMatchObject({
      state: 'en-cours',
      title: 'IA for OPS on Scaleway',
      rooms: 1,
    })
  })

  it('marque la salle en break dans la supervision', async () => {
    hub.services.clock.setSimulated('2026-10-30T11:40:00.000Z')
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    const salles = await admin.rooms.statuses()
    const salle = salles.find((s) => s.roomId === TRACK_1)!

    expect(salle.breakBadge).toMatchObject({ state: 'en-cours', title: 'Déjeuner' })
    // Et la pastille dit qu'il n'y a personne, pas qu'une conférence attend.
    expect(salle.conference).toBe('pause')
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
    // deux ou trois qui ont été lancés — plus les onze pauses communes
    // projetées, qui disent ce que chaque salle affichera vraiment.
    expect(planning.sessions).toHaveLength(38)
    expect(planning.sessions.filter((s) => s.sharedFrom != null)).toHaveLength(11)
    // Le nom du hub l'emporte sur celui du programme : une salle se renomme
    // depuis la console, et c'est ce nom-là qui est écrit sur la porte.
    expect(planning.sessions.find((s) => s.roomId === TRACK_1)?.roomName).toBe(
      'Track #1 - Teilhard de Chardin',
    )
  })

  /**
   * Le vécu de la journée, joint au programme par le hub.
   *
   * Centralisé ici parce que le cycle de vie est écrit ici et vaut pour toutes
   * les salles à la fois : une console qui recroiserait elle-même deux listes
   * finirait par en afficher une version qui n'est celle de personne.
   */
  it('joint le début et la fin réels de chaque conférence', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const talk = (await admin.program.planning()).sessions.find(
      (session) => session.kind === 'talk' && session.roomId === TRACK_1,
    )!

    // Rien tant que personne n'a piloté : reprendre l'horaire du programme
    // affirmerait qu'un talk s'est tenu quand rien ne l'atteste.
    expect(talk.startedAt).toBeNull()
    expect(talk.endedAt).toBeNull()

    const lancee = await admin.sessions.start({ sessionId: talk.id })
    const apresDepart = (await admin.program.planning()).sessions.find((s) => s.id === talk.id)!
    expect(apresDepart.startedAt).toBe(lancee.startedAt)
    // Toujours ouverte : on ne referme pas le créneau à la place de l'opérateur.
    expect(apresDepart.endedAt).toBeNull()
    // Le prévu reste le prévu : les deux se lisent côte à côte, et c'est
    // l'écart qui intéresse.
    expect(apresDepart.startsAt).toBe(talk.startsAt)

    const close = await admin.sessions.end({ sessionId: talk.id })
    const apresFin = (await admin.program.planning()).sessions.find((s) => s.id === talk.id)!
    expect(apresFin.startedAt).toBe(lancee.startedAt)
    expect(apresFin.endedAt).toBe(close.endedAt)
    // Qui a décidé : la seule chose qui réponde à « je n'ai pas fait ça ».
    expect(apresFin.decidedBy).toBe(OPERATOR.email)

    // Remise à venir : le vécu disparaît avec la décision qui le portait.
    await admin.sessions.reset({ sessionId: talk.id })
    const apresAnnulation = (await admin.program.planning()).sessions.find((s) => s.id === talk.id)!
    expect(apresAnnulation.startedAt).toBeNull()
    expect(apresAnnulation.endedAt).toBeNull()
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

  it('donne le lien à toutes les salles dès que le hub a son projet', async () => {
    // Le bogue constaté tenait à un second propriétaire du réglage : la salle 1
    // le portait, les autres non, et vingt-six créneaux sur vingt-sept
    // restaient sans lien. Un seul propriétaire, et la question ne se pose
    // plus — le projet vaut pour toutes les salles à la fois.
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    await admin.settings.update({ openFeedbackProjectId: 'cloud-nord-2026' })

    const planning = await admin.program.planning()

    const talks = planning.sessions.filter((session) => session.kind === 'talk')
    const salles = new Set(talks.map((session) => session.roomId))
    expect(salles.size).toBeGreaterThan(1)
    expect(talks.every((session) => session.feedbackUrl != null)).toBe(true)
    expect(planning.openFeedbackProjectId).toBe('cloud-nord-2026')
  })

  it('ignore un projet resté sur une salle', async () => {
    // Une base d'avant le changement en porte encore. Il ne doit plus rien
    // décider : sans réglage sur le hub, personne n'a de lien — la reprise au
    // démarrage est le seul endroit qui regarde encore ce champ.
    const salle = hub.services.rooms.get(TRACK_1)!
    hub.services.rooms.upsert({ ...salle, openFeedbackProjectId: 'cloud-nord-2026' })

    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const planning = await admin.program.planning()

    expect(planning.openFeedbackProjectId).toBeNull()
    expect(planning.sessions.every((session) => session.feedbackUrl == null)).toBe(true)
  })

  it('ne prend pas une chaîne vide pour un projet OpenFeedback', async () => {
    // Un champ texte laissé vide arrive en `''`, pas en `null`, et `??` le
    // laisse passer : le repli était écrasé, et l'adresse fabriquée pointait
    // sur `openfeedback.io///…`. Mieux vaut pas de lien qu'un lien mort.
    hub.services.settings.update({ openFeedbackProjectId: '   ' })

    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const planning = await admin.program.planning()

    expect(planning.openFeedbackProjectId).toBeNull()
    expect(planning.sessions.every((session) => session.feedbackUrl == null)).toBe(true)
  })

  it('corrige l\'identifiant OpenFeedback d\'un créneau', async () => {
    // Le pari « OpenFeedback réutilise les identifiants de l'export » se perd en
    // silence : le lien reste cliquable, le QR reste scannable, et les deux
    // mènent à une page qui ne parle d'aucun talk. Sans cette correction, un QR
    // mort ne se répare pas — l'export le ramènerait à chaque import.
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    await admin.settings.update({ openFeedbackProjectId: 'cloud-nord-2026' })
    const talk = (await admin.program.planning()).sessions.find((s) => s.kind === 'talk')!

    const pose = await admin.sessions.feedbackId({ sessionId: talk.id, feedbackId: 'of-42' })

    expect(pose.feedbackId).toBe('of-42')
    expect(pose.feedbackUrl).toBe('https://openfeedback.io/cloud-nord-2026/2026-10-30/of-42')

    const apres = (await admin.program.planning()).sessions.find((s) => s.id === talk.id)!
    expect(apres.feedbackId).toBe('of-42')
    expect(apres.feedbackIdOverride).toBe('of-42')
    // L'identifiant du créneau, lui, ne bouge pas : c'est la clé du cycle de vie.
    expect(apres.id).toBe(talk.id)
  })

  it('fait suivre la correction jusqu\'au programme servi aux salles', async () => {
    // La salle dessine ses QR hors ligne depuis ce programme. Si la correction
    // n'y était pas, la console afficherait la bonne adresse pendant que
    // l'écran en projetterait une autre — et c'est celle devant le public qui
    // serait la mauvaise.
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    await admin.settings.update({ openFeedbackProjectId: 'cloud-nord-2026' })
    const talk = (await admin.program.planning()).sessions.find(
      (s) => s.kind === 'talk' && s.roomId === TRACK_1,
    )!
    const room = wsClient(await pairRoomDevice())
    const avant = await room.rooms.sync({ since: null })

    await admin.sessions.feedbackId({ sessionId: talk.id, feedbackId: 'of-42' })

    const apres = await room.rooms.sync({ since: avant.contentHash })
    // L'empreinte bouge : sans cela une salle resterait sur son cache, à
    // projeter l'adresse qu'on vient justement de déclarer fausse.
    expect(apres.contentHash).not.toBe(avant.contentHash)
    expect(apres.program).not.toBeNull()
    const servi = apres.program!.sessions.find((s) => s.id === talk.id)!
    expect(servi.feedbackId).toBe('of-42')
  }, 20_000)

  it('rend un créneau à l\'identifiant de l\'export', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    await admin.settings.update({ openFeedbackProjectId: 'cloud-nord-2026' })
    const talk = (await admin.program.planning()).sessions.find((s) => s.kind === 'talk')!
    await admin.sessions.feedbackId({ sessionId: talk.id, feedbackId: 'of-42' })

    const retire = await admin.sessions.feedbackId({ sessionId: talk.id, feedbackId: null })

    expect(retire.feedbackId).toBe(talk.id)
    const apres = (await admin.program.planning()).sessions.find((s) => s.id === talk.id)!
    expect(apres.feedbackIdOverride).toBeNull()
    expect(apres.feedbackUrl).toBe(
      `https://openfeedback.io/cloud-nord-2026/2026-10-30/${talk.id}`,
    )
  })

  it('ne compte pas une correction qui redit l\'export', async () => {
    // Même règle que pour les décisions de genre : une correction sans objet ne
    // doit pas changer l'empreinte, sinon les salles retéléchargent pour rien.
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const talk = (await admin.program.planning()).sessions.find((s) => s.kind === 'talk')!
    const avant = (await admin.program.planning()).contentHash

    await admin.sessions.feedbackId({ sessionId: talk.id, feedbackId: talk.id })

    const apres = await admin.program.planning()
    expect(apres.contentHash).toBe(avant)
    expect(apres.sessions.find((s) => s.id === talk.id)?.feedbackIdOverride).toBeNull()
  })

  it('refuse de corriger l\'identifiant d\'une pause', async () => {
    // Une pause n'a pas de page de retours : la ligne posée ne serait relue par
    // personne.
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const pause = (await admin.program.planning()).sessions.find((s) => s.kind === 'break')!

    await expect(
      admin.sessions.feedbackId({ sessionId: pause.id, feedbackId: 'of-42' }),
    ).rejects.toThrow()
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

describe('dossier VOD d\'une conférence', () => {
  /** Le talk de la salle 1, celui que la régie de test enregistre. */
  const talkDeLaSalle1 = async (admin: Client) => {
    const planning = await admin.program.planning()
    const talk = planning.sessions.find(
      (session) => session.kind === 'talk' && session.roomId === TRACK_1,
    )
    expect(talk).toBeTruthy()
    return talk!
  }

  it('répond sans stockage configuré, prises comprises', async () => {
    // **Le point de la procédure.** Les deux moitiés ne viennent pas du même
    // endroit : les prises se recomposent depuis le journal d'ingestion, que
    // tout hub tient, et seuls les téléversements réclament S3. Refuser faute
    // de stockage priverait un hub sans S3 de la seule réponse qui compte le
    // soir du démontage — « le rush est-il sur la machine ? ».
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const talk = await talkDeLaSalle1(admin)

    hub.services.ingest.push(TRACK_1, [
      {
        id: '01H1AAAAAAAAAAAAAAAAAAAAAA',
        roomId: TRACK_1,
        seq: 1,
        occurredAt: '2026-10-30T10:00:00.000+00:00',
        monotonicMs: 1000,
        delivery: 'required',
        payload: { type: 'recording.started', obs: 'B', sessionId: talk.id },
      },
      {
        id: '01H2AAAAAAAAAAAAAAAAAAAAAA',
        roomId: TRACK_1,
        seq: 2,
        occurredAt: '2026-10-30T10:50:00.000+00:00',
        monotonicMs: 2000,
        delivery: 'required',
        payload: {
          type: 'recording.stopped',
          obs: 'B',
          sessionId: talk.id,
          outputPath: '/rushes/le-talk.mkv',
          durationMs: 3_000_000,
          sidecarWritten: true,
        },
      },
    ])

    const dossier = await admin.vod.conference({ sessionId: talk.id })

    expect(dossier.stockageConfigure).toBe(false)
    expect(dossier.roomId).toBe(TRACK_1)
    expect(dossier.captations).toHaveLength(1)
    expect(dossier.captations[0]).toMatchObject({
      file: '/rushes/le-talk.mkv',
      sidecarWritten: true,
      enCours: false,
      // Estampillée par la régie : ce n'est pas une déduction.
      rattachement: 'session',
    })
    expect(dossier.televersements).toEqual([])
  })

  it('rattache à l\'heure une prise lancée hors du cycle de vie', async () => {
    // Un enregistrement démarré à la main ne porte aucun créneau. Le rush
    // existe pourtant, et il est même le seul : le laisser invisible reviendrait
    // à le faire chercher fichier par fichier.
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const talk = await talkDeLaSalle1(admin)
    hub.services.clock.setSimulated('2026-10-30T10:05:00.000Z')
    await admin.sessions.start({ sessionId: talk.id })

    hub.services.ingest.push(TRACK_1, [
      {
        id: '01J1AAAAAAAAAAAAAAAAAAAAAA',
        roomId: TRACK_1,
        seq: 1,
        occurredAt: '2026-10-30T10:06:00.000+00:00',
        monotonicMs: 1000,
        delivery: 'required',
        payload: { type: 'recording.started', obs: 'B', sessionId: null },
      },
    ])

    const dossier = await admin.vod.conference({ sessionId: talk.id })

    expect(dossier.captations).toHaveLength(1)
    // Une piste, pas un fait : la console l'affiche comme telle.
    expect(dossier.captations[0]).toMatchObject({ rattachement: 'horaire', enCours: true })
  })

  it('n\'attribue pas à une conférence la prise estampillée d\'une autre', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const talk = await talkDeLaSalle1(admin)
    hub.services.clock.setSimulated('2026-10-30T10:05:00.000Z')
    await admin.sessions.start({ sessionId: talk.id })

    hub.services.ingest.push(TRACK_1, [
      {
        id: '01K1AAAAAAAAAAAAAAAAAAAAAA',
        roomId: TRACK_1,
        seq: 1,
        occurredAt: '2026-10-30T10:06:00.000+00:00',
        monotonicMs: 1000,
        delivery: 'required',
        payload: { type: 'recording.started', obs: 'B', sessionId: 'un-autre-creneau' },
      },
    ])

    const dossier = await admin.vod.conference({ sessionId: talk.id })

    // Elle recouvre bien l'heure, mais elle appartient déjà à quelqu'un : le
    // repli horaire ne sert qu'aux prises que personne ne réclame.
    expect(dossier.captations).toEqual([])
  })

  it('refuse une conférence inconnue au programme', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    await expect(admin.vod.conference({ sessionId: 'ses-inexistante' })).rejects.toThrow()
  })

  it('reste fermé aux machines de salle', async () => {
    // Le dossier croise toutes les salles : c'est une vue de console.
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const talk = await talkDeLaSalle1(admin)
    const machine = httpClient(await pairRoomDevice())

    await expect(machine.vod.conference({ sessionId: talk.id })).rejects.toThrow()
  })
})
