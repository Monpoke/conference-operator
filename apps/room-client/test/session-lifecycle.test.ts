import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHub, type Hub } from '@cloudnord/hub-server/server'
import { provisionOperator } from '@cloudnord/hub-server/operators'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { contract } from '@cloudnord/contract'
import { RoomApp } from '../src/core/room-app.js'
import { createMockObsTransport } from '../src/core/obs-mock.js'
import type { DisplayPayload } from '../src/core/display-server.js'

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'motdepasse-regie-2026' }
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'
const TRACK_1 = 'track-1-teilhard-de-chardin'
/** 10:20 UTC : « HoneySwamp » court de 10:00 à 10:50. */
const PENDANT_LE_TALK = Date.parse('2026-10-30T10:20:00.000Z')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let hub: Hub
let origin: string
let dir: string
let room: RoomApp
let regie: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-cycle-'))
  hub = await createHub({
    port: 0,
    host: '127.0.0.1',
    databasePath: ':memory:',
    publicUrl: 'http://127.0.0.1',
    authSecret: 'test-secret-'.padEnd(48, 'x'),
    logLevel: 'fatal',
    devicePollInterval: '1s',
    /**
     * L'instant se simule **sur le hub**, pas dans la salle.
     *
     * Une horloge posée dans la salle serait remplacée à la première
     * synchronisation : le hub fait foi, la salle mesure son écart contre lui.
     * Ce test simulait son propre temps et ne tenait que grâce à un écart
     * calculé de travers — celui-là même qui laissait la régie sans conférence
     * à piloter en heure simulée.
     */
    mode: 'dev',
    simulatedTime: new Date(PENDANT_LE_TALK).toISOString(),
  })
  await hub.app.listen({ port: 0, host: '127.0.0.1' })
  const address = hub.app.server.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`

  await provisionOperator(hub.auth, OPERATOR)
  const snapshot = hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
  hub.services.rooms.ensureFromTracks(snapshot.program.rooms)

  let token: string | null = null
  room = new RoomApp({
    dataDir: dir,
    hubOrigin: origin,
    clientId: CLIENT_ID,
    // Salle connue d'avance : ces tests n'ont pas d'écran pour la choisir.
    roomId: TRACK_1,
    displayPort: 0,
    obsTransportFactory: (instance) =>
      createMockObsTransport({ instance, recordingDir: join(dir, 'rec') }),
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

/** Client opérateur : ce que la console tient une fois connectée. */
async function operateur(): Promise<ContractRouterClient<typeof contract>> {
  const response = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
  })
  const session = (await response.json()) as { token: string }
  return createORPCClient(
    new RPCLink({ origin, url: '/rpc', headers: () => ({ authorization: `Bearer ${session.token}` }) }),
  )
}

describe('cycle de vie piloté depuis la régie', () => {
  it('démarre et termine la conférence en cours', async () => {
    const session = room.runtime.state().currentSession!
    expect(session.title).toContain('HoneySwamp')

    expect((await agir({ action: 'session.start' })).body.ok).toBe(true)
    expect((await etat()).state.sessionStates[session.id]).toBe('running')
    // La décision est visible côté hub : c'est là qu'elle compte pour la console.
    expect(hub.services.sessions.get(session.id)?.status).toBe('running')

    expect((await agir({ action: 'session.end' })).body.ok).toBe(true)
    expect((await etat()).state.sessionStates[session.id]).toBe('ended')
  }, 40_000)

  it('reçoit une décision prise depuis la console', async () => {
    const session = room.runtime.state().currentSession!
    hub.services.sessions.start(session.id, TRACK_1, 'organisateur@cloudnord.fr')
    hub.services.commands.publish(
      TRACK_1,
      {
        type: 'session.state',
        sessionId: session.id,
        roomId: TRACK_1,
        sessionTitle: session.title,
        status: 'running',
        decidedBy: 'organisateur@cloudnord.fr',
      },
      null,
    )
    await sleep(500)

    // Un talk peut déborder sans que l'opérateur de salle soit disponible.
    expect((await etat()).state.sessionStates[session.id]).toBe('running')
  }, 40_000)

  it('reçoit une clôture automatique et l\'affiche comme telle', async () => {
    const session = room.runtime.state().currentSession!
    await agir({ action: 'session.start' })
    expect((await etat()).state.sessionStates[session.id]).toBe('running')

    // La *règle* horaire est vérifiée dans les tests du hub, avec une horloge
    // simulée. Ici on vérifie le fil : ce que la règle décide arrive bien à la
    // salle, et s'y distingue d'une décision humaine.
    const clos = hub.services.sessions.end(session.id, TRACK_1, 'auto')
    hub.services.commands.publish(
      TRACK_1,
      {
        type: 'session.state',
        sessionId: session.id,
        roomId: TRACK_1,
        sessionTitle: session.title,
        status: 'ended',
        decidedBy: 'auto',
      },
      null,
    )
    await sleep(500)

    expect(clos.decidedBy).toBe('auto')
    expect((await etat()).state.sessionStates[session.id]).toBe('ended')
  }, 40_000)

  it('vise le premier talk quand la journée n\'a pas commencé', async () => {
    // Avant l'événement, toutes les conférences sont à venir : pouvoir démarrer
    // la première est utile, pas absurde — c'est une répétition.
    room.runtime.setClockOffset(-400 * 24 * 3600 * 1000)
    room.runtime.refreshSessions()

    expect(room.runtime.state().currentSession).toBeNull()
    expect(room.runtime.state().targetSession?.kind).toBe('talk')
    expect((await agir({ action: 'session.start' })).status).toBe(200)
  }, 40_000)

  it('n\'a plus rien à piloter une fois la journée finie', async () => {
    // Après le dernier talk, il n'y a plus de cible : là, le refus est juste.
    room.runtime.setClockOffset(Date.parse('2026-10-31T12:00:00Z') - Date.now())
    room.runtime.refreshSessions()

    expect(room.runtime.state().targetSession).toBeNull()
    const resultat = await agir({ action: 'session.start' })
    expect(resultat.status).toBe(409)
    expect(resultat.body.message).toContain('Aucune conférence')
  }, 40_000)

  it('expose l\'état des autres salles à la régie', async () => {
    await sleep(300)
    const rooms = (await etat()).diagnostics?.rooms ?? []
    // Les trois tracks du programme sont devenues des salles.
    expect(rooms.map((r) => r.roomId).sort()).toEqual(
      ['hands-on', 'track-1-teilhard-de-chardin', 'track-2-mf-1092'],
    )
    expect((await etat()).diagnostics?.roomsRefreshedAt).toBeTruthy()
  }, 40_000)
})

describe("heure simulée", () => {
  it("laisse celle du hub reprendre la main sur un décalage local", async () => {
    /**
     * Le cas signalé : une salle lancée avec `HEURE_SIMULEE`, raccordée à un
     * hub lui aussi en heure simulée. Les deux écarts se cumulaient — la régie
     * annonçait « aucune conférence à piloter » pendant que le flux des autres
     * salles, calculé dans la page, tombait juste.
     */
    room.runtime.setClockOffset(Date.parse('2026-11-30T10:20:00.000Z') - Date.now(), true)
    expect(room.runtime.state().currentSession).toBeNull()

    await room.resync()

    expect(room.runtime.state().currentSession?.title).toContain('HoneySwamp')
    // Et les pages voient le même instant : elles n'ont que leur `Date.now()`.
    const vuParUnePage = Date.now() + room.runtime.state().serverTimeOffsetMs
    expect(Math.abs(vuParUnePage - room.runtime.correctedNow())).toBeLessThan(100)
  }, 40_000)

  it("annule en régie les décisions prises plus tard dans la journée", async () => {
    /**
     * Le cas signalé : on essaie la journée, on lance « HoneySwamp » à 10:20,
     * puis on recule l'horloge à 08:38 pour reprendre au matin. La régie
     * gardait « en cours » et déroulait deux heures de compte à rebours sur une
     * conférence que personne n'avait démarrée — l'état venait d'une journée
     * qui n'avait pas encore eu lieu.
     */
    const session = room.runtime.state().currentSession!
    await agir({ action: 'session.start' })
    expect((await etat()).state.sessionStates[session.id]).toBe('running')

    const admin = await operateur()
    await admin.clock.set({ at: '2026-10-30T07:38:00.000Z' })
    await sleep(600)

    // Le hub n'applique plus la décision…
    expect(hub.services.sessions.get(session.id)).toBeNull()
    // …et la salle non plus : elle relit le cycle de vie quand l'heure bouge.
    const payload = await etat()
    expect(payload.state.sessionStates[session.id]).toBeUndefined()
    // Et la régie repart sur le matin : le prochain talk, pas encore commencé.
    expect(payload.state.currentSession?.id).not.toBe(session.id)
    expect(payload.state.targetSession?.startsAtMs).toBeGreaterThan(
      Date.parse('2026-10-30T07:38:00.000Z'),
    )
    expect(payload.state.targetIsUpcoming).toBe(true)
  }, 40_000)
})

/**
 * Resynchronisation demandée depuis la console.
 *
 * Le seul recours, avant, était de redémarrer la machine de salle — donc de
 * couper sa captation, au moment précis où l'on constate qu'elle a dérivé.
 */
describe('resynchronisation complète', () => {
  it("relit tout sur demande de la console, sans couper la salle", async () => {
    const admin = await operateur()
    const avant = room.runtime.state().recording

    await admin.rooms.resync({ roomId: TRACK_1 })
    await sleep(800)

    const payload = await etat()
    const textes = payload.state.notifications.map((n) => n.text)
    // Signalé en régie : une salle qui se remet à télécharger son programme
    // sans que personne ne l'ait demandé sur place se lit comme un incident.
    expect(textes.some((t) => t.includes(OPERATOR.email))).toBe(true)
    expect(textes).toContain('Resynchronisation complète terminée')

    // Rien n'a été coupé : c'est tout l'intérêt du geste.
    expect(payload.state.recording).toBe(avant)
    expect(payload.pairing?.status).toBe('paired')
    expect(payload.state.connectivity).toBe('ONLINE')
    // Et la salle est toujours sur le programme du hub.
    expect(room.runtime.state().currentSession?.title).toContain('HoneySwamp')
  }, 40_000)

  it("redemande le programme entier, là où un sync ordinaire s'en dispense", async () => {
    /**
     * C'est ce qui distingue ce geste d'un `sync` ordinaire : le sync s'appuie
     * sur l'empreinte pour ne pas retélécharger 70 ko à chaque battement, et
     * c'est justement le cache qu'on soupçonne ici. Le programme redescendu se
     * constate à l'écriture en base locale.
     */
    const store = (room as unknown as { store: { saveProgram: (...args: never[]) => void } }).store
    const ecrit = vi.spyOn(store, 'saveProgram')

    // Le sync ordinaire n'écrit rien : l'empreinte n'a pas bougé.
    await room.resync()
    expect(ecrit).not.toHaveBeenCalled()

    const admin = await operateur()
    await admin.rooms.resync({ roomId: null })
    await sleep(800)

    expect(ecrit).toHaveBeenCalled()
    ecrit.mockRestore()
  }, 40_000)
})

/**
 * Créneaux dont le genre se corrige depuis la console.
 *
 * L'export amont ne distingue pas un déjeuner d'une conférence, et le
 * normaliseur tranche sur un seul signal : pas d'intervenant, donc une pause.
 * La correction doit se voir *en salle*, sinon elle ne sert à rien là où elle
 * compte.
 */
describe('genre d\'un créneau corrigé depuis le hub', () => {
  it("cesse d'être une conférence en salle, sans rien redémarrer", async () => {
    const session = room.runtime.state().currentSession!
    expect(session.title).toContain('HoneySwamp')
    expect(room.runtime.state().targetSession?.id).toBe(session.id)

    const admin = await operateur()
    await admin.sessions.override({ sessionId: session.id, action: 'break' })
    // Le hub diffuse `program.invalidate` : la salle resynchronise d'elle-même.
    await sleep(1_000)
    room.runtime.refreshSessions()

    const etatSalle = room.runtime.state()
    // Le créneau court toujours — il occupe la salle — mais ce n'est plus une
    // conférence : la régie vise le talk suivant, celui qu'on peut lancer.
    expect(etatSalle.currentSession?.id).toBe(session.id)
    expect(etatSalle.currentSession?.kind).toBe('break')
    expect(etatSalle.targetSession?.id).not.toBe(session.id)
    expect(etatSalle.targetSession?.kind).toBe('talk')
    expect(etatSalle.targetIsUpcoming).toBe(true)

    // Et rien n'a été coupé au passage.
    expect(etatSalle.connectivity).toBe('ONLINE')
    expect((await etat()).pairing?.status).toBe('paired')
  }, 40_000)

  it("rend pilotable une keynote que l'export donne pour une pause", async () => {
    /**
     * Le cas signalé : le speaker de la keynote d'ouverture n'est pas encore
     * annoncé, donc l'export ne lui en donne aucun, donc le normaliseur en fait
     * une pause. La régie n'avait rien à lancer, et rien ne partait à l'antenne.
     */
    const admin = await operateur()
    const keynote = hub.services.programs
      .active()!
      .program.sessions.find((s) => s.title.includes('Keynote'))!
    expect(keynote.kind).toBe('break')

    await admin.sessions.override({ sessionId: keynote.id, action: 'talk' })
    await sleep(1_000)

    // 08:10 UTC : la keynote court de 08:00 à 08:45.
    room.runtime.setClockOffset(Date.parse('2026-10-30T08:10:00Z') - Date.now())
    room.runtime.refreshSessions()

    const etatSalle = room.runtime.state()
    expect(etatSalle.currentSession?.id).toBe(keynote.id)
    expect(etatSalle.currentSession?.kind).toBe('talk')
    // Elle est désormais la conférence que la régie pilote.
    expect(etatSalle.targetSession?.id).toBe(keynote.id)
    expect(etatSalle.targetIsUpcoming).toBe(false)
    expect((await agir({ action: 'session.start' })).status).toBe(200)
  }, 40_000)

  it('redevient une conférence quand on retire la décision', async () => {
    const session = room.runtime.state().currentSession!
    const admin = await operateur()

    await admin.sessions.override({ sessionId: session.id, action: 'break' })
    await sleep(1_000)
    await admin.sessions.override({ sessionId: session.id, action: null })
    await sleep(1_000)
    room.runtime.refreshSessions()

    expect(room.runtime.state().currentSession?.kind).toBe('talk')
    expect(room.runtime.state().targetSession?.id).toBe(session.id)
  }, 40_000)
})

describe("identifiants refusés par le hub", () => {
  it("réaffiche l'écran d'appairage au lieu de boucler", async () => {
    // Le cas vécu : la base du hub a été recréée, ou la machine a été révoquée.
    // Le jeton stocké ne vaut plus rien. Réessayer indéfiniment ne mène nulle
    // part et n'apprend rien à l'opérateur.
    expect(room.pairingState().status).toBe('paired')

    hub.services.devices.revoke(CLIENT_ID)
    const resultat = await room.resync().then(
      () => 'ok',
      (cause: Error) => cause.message,
    )
    expect(resultat).toContain('injoignable')

    // L'écran de régie porte désormais l'état d'appairage.
    await sleep(300)
    const payload = await etat()
    expect(payload.pairing?.status).not.toBe('paired')
  }, 40_000)

  it("expose l'état d'appairage à la régie dès le démarrage", async () => {
    const payload = await etat()
    // Une machine appairée ne doit rien afficher : le voile ne sert qu'au cas
    // contraire.
    expect(payload.pairing?.status).toBe('paired')
  }, 40_000)
})

describe('notifications inter-salles', () => {
  it("signale la fin d'une conférence dans une autre salle sans toucher à son état", async () => {
    const autre = hub.services.programs
      .active()!
      .program.sessions.find((s) => s.roomId === 'track-2-mf-1092' && s.kind === 'talk')!

    hub.services.sessions.start(autre.id, 'track-2-mf-1092', 'organisateur')
    hub.services.commands.publish(
      // Diffusion générale : c'est ce qui rend la notification possible.
      null,
      {
        type: 'session.state',
        sessionId: autre.id,
        roomId: 'track-2-mf-1092',
        sessionTitle: autre.title,
        status: 'ended',
        decidedBy: 'auto',
      },
      null,
    )
    await sleep(600)

    const payload = await etat()
    const textes = payload.state.notifications.map((n) => n.text)
    expect(textes.some((t) => t.includes(autre.title))).toBe(true)

    // L'état d'une autre salle ne doit pas polluer le nôtre.
    expect(payload.state.sessionStates[autre.id]).toBeUndefined()
  }, 40_000)

  it("applique normalement une décision qui concerne sa propre salle", async () => {
    const session = room.runtime.state().currentSession!
    hub.services.sessions.start(session.id, TRACK_1, 'organisateur')
    hub.services.commands.publish(
      null,
      {
        type: 'session.state',
        sessionId: session.id,
        roomId: TRACK_1,
        sessionTitle: session.title,
        status: 'running',
        decidedBy: 'organisateur',
      },
      null,
    )
    await sleep(600)

    const payload = await etat()
    expect(payload.state.sessionStates[session.id]).toBe('running')
    // Sa propre salle ne se notifie pas : l'écran le montre déjà.
    expect(payload.state.notifications).toEqual([])
  }, 40_000)

  it("sert le programme d'une autre salle à la demande", async () => {
    const reponse = await fetch(`${regie}/display/sessions?salle=track-2-mf-1092`)
    const corps = (await reponse.json()) as {
      sessions: { sharedFrom: string | null }[]
      rooms: unknown[]
    }

    // Neuf créneaux à l'export pour Track #2, quinze servis : elle hérite des
    // six pauses de Track #1, qui tombent toutes pendant qu'elle est libre.
    // C'est précisément ce que la régie vient lire — sans ça, la salle voisine
    // paraissait déserte pendant le déjeuner.
    expect(corps.sessions).toHaveLength(15)
    expect(corps.sessions.filter((s) => s.sharedFrom != null)).toHaveLength(6)
    expect(corps.rooms).toHaveLength(3)

    // Hors du flux d'état : embarquer le programme entier à chaque envoi SSE
    // coûterait pour une donnée consultée à l'ouverture d'un onglet.
    const payload = await etat()
    expect(payload.sessions).toHaveLength(15)
  }, 40_000)

  it("refuse une salle absente du programme", async () => {
    expect((await fetch(`${regie}/display/sessions?salle=inventee`)).status).toBe(404)
  }, 40_000)
})

describe('échange de messages', () => {
  const rpcAdmin = async (chemin: string, entree: unknown) => {
    const reponse = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
    })
    const session = (await reponse.json()) as { token: string }
    const appel = await fetch(`${origin}/rpc/${chemin}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ json: entree }),
    })
    return { status: appel.status, body: (await appel.json()) as { json?: never } }
  }

  it("adresse un message à l'opérateur sans toucher à l'écran de salle", async () => {
    const avant = (await etat()).state.mode

    await rpcAdmin('messages/send', {
      roomId: TRACK_1,
      text: 'Ton speaker est arrivé',
      level: 'info',
      target: 'operator',
      ttlSeconds: null,
    })
    await sleep(600)

    const payload = await etat()
    // Projeter une note à l'opérateur devant le public ne se rattrape pas.
    expect(payload.state.mode).toBe(avant)
    expect(payload.state.message).toBeNull()
    expect(payload.state.notifications.map((n) => n.text).join(' ')).toContain('speaker est arrivé')
  }, 40_000)

  it("prend l'écran de salle pour un message urgent au public", async () => {
    await rpcAdmin('messages/send', {
      roomId: TRACK_1,
      text: 'Évacuation — rejoignez la sortie la plus proche',
      level: 'urgent',
      target: 'audience',
      /**
       * Sans TTL ici : ces tests tournent sur une horloge simulée en octobre,
       * alors que le hub émet à la date du jour. Le filtre d'obsolescence
       * — correct par ailleurs — écarterait la commande avant application.
       * L'expiration d'affichage est couverte par les tests du runtime.
       */
      ttlSeconds: null,
    })
    await sleep(600)

    const payload = await etat()
    expect(payload.state.mode).toBe('message')
    expect(payload.state.message).toMatchObject({ level: 'urgent' })
    // La régie sait ce qui est projeté chez elle.
    expect(payload.state.notifications.map((n) => n.text).join(' ')).toContain('Affiché en salle')
  }, 40_000)

  it('atteint toutes les salles quand aucune n\'est précisée', async () => {
    const resultat = await rpcAdmin('messages/send', {
      roomId: null,
      text: 'Ouverture des portes dans 5 minutes',
      level: 'info',
      target: 'operator',
      ttlSeconds: null,
    })
    expect(resultat.status).toBe(200)
    await sleep(600)
    expect((await etat()).state.notifications.map((n) => n.text).join(' ')).toContain(
      'Ouverture des portes',
    )
  }, 40_000)

  it('remonte un message de la salle à la console', async () => {
    await fetch(`${regie}/control/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'message.send', text: "Besoin d'aide en salle", level: 'urgent' }),
    })
    // Passe par l'outbox : le temps que le lot parte.
    await sleep(3_000)

    const recus = await rpcAdmin('messages/fromRooms', { limit: 10 })
    const messages = recus.body.json as unknown as { text: string; roomName: string; level: string }[]
    expect(messages[0]).toMatchObject({
      text: "Besoin d'aide en salle",
      level: 'urgent',
      roomName: 'Track #1 - Teilhard de Chardin',
    })
  }, 40_000)

  it('réserve l\'envoi aux opérateurs', async () => {
    const anonyme = await fetch(`${origin}/rpc/messages/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        json: { roomId: null, text: 'coucou', level: 'info', target: 'audience', ttlSeconds: null },
      }),
    })
    expect(anonyme.status).toBe(401)
  }, 40_000)
})
