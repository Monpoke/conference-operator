import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHub, type Hub } from '@cloudnord/hub-server/server'
import { provisionOperator } from '@cloudnord/hub-server/operators'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { contract } from '@cloudnord/contract'
import { RoomApp } from '../src/core/room-app.js'
import { createMockObsTransport } from '../src/core/obs-mock.js'

/**
 * La chaîne entière, du rush sur le disque à l'objet chez le stockage.
 *
 * C'est le seul test qui prouve que ça marche. Les autres tiennent chacun leur
 * bout — la signature, le registre, le régulateur, le découpage — et tous
 * peuvent être verts pendant que le fichier arrive corrompu à l'autre bout,
 * parce que le seul endroit où les octets se recomposent est chez S3.
 *
 * Ici il y a un vrai hub, une vraie salle, un vrai OBS simulé qui écrit un vrai
 * fichier, et un faux S3 qui recompose l'objet comme le vrai. Ce qu'on vérifie
 * au bout est la seule chose qui compte le soir de l'événement : que ce qui est
 * arrivé là-bas est **octet pour octet** ce qui a été enregistré ici.
 */

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

/**
 * Un S3 de poche : multipart, parts, clôture, abandon, inventaire.
 *
 * Il ne vérifie pas les signatures — c'est le rôle de `s3.test.ts`, sur les
 * vecteurs officiels d'AWS. Il fait la seule chose que ce test-ci a besoin de
 * voir faite pour de vrai : recoller les parts **dans l'ordre des numéros**, et
 * rendre l'objet complet.
 */
function fauxStockage(tls: { key: string; cert: string } | null = null) {
  // `FastifyInstance` explicite : monter en HTTPS change le type du serveur
  // sous-jacent, et le reste de ce faux stockage n'a aucune raison d'en
  // connaître deux variantes.
  const app: FastifyInstance =
    tls == null
      ? Fastify({ logger: false })
      : (Fastify({ logger: false, https: tls } as never) as unknown as FastifyInstance)
  const multiparts = new Map<string, Map<number, Buffer>>()
  const objets = new Map<string, Buffer>()
  const abandons: string[] = []
  let compteur = 0

  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, corps, fait) => fait(null, corps))

  app.route({
    method: ['GET', 'PUT', 'POST', 'DELETE'],
    url: '/*',
    handler: (request, reply) => {
      // `/bucket/cle...` — adressage par chemin, celui que le hub emploie.
      const chemin = decodeURIComponent(request.url.split('?')[0] ?? '')
      const key = chemin.replace(/^\/[^/]+\/?/, '')
      const query = new URL(request.url, 'http://s3.local').searchParams
      const corps = request.body as Buffer | undefined

      if (request.method === 'POST' && query.has('uploads')) {
        compteur += 1
        const uploadId = `mp-${compteur}`
        multiparts.set(uploadId, new Map())
        return reply
          .type('application/xml')
          .send(`<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`)
      }

      if (request.method === 'PUT' && query.has('uploadId')) {
        const parts = multiparts.get(query.get('uploadId') ?? '')
        if (parts == null) return reply.status(404).send('<Error><Code>NoSuchUpload</Code></Error>')
        const numero = Number(query.get('partNumber'))
        parts.set(numero, corps ?? Buffer.alloc(0))
        // L'ETag est ce que le hub retiendra et redemandera à la clôture.
        return reply.header('etag', `"part-${numero}"`).send('')
      }

      if (request.method === 'PUT') {
        objets.set(key, corps ?? Buffer.alloc(0))
        return reply.header('etag', '"objet"').send('')
      }

      if (request.method === 'POST' && query.has('uploadId')) {
        const uploadId = query.get('uploadId') ?? ''
        const parts = multiparts.get(uploadId)
        if (parts == null) return reply.status(404).send('<Error><Code>NoSuchUpload</Code></Error>')
        // Recollage dans l'ordre des **numéros**, pas dans celui d'arrivée :
        // c'est ce que fait le vrai, et c'est ce qui rend une part rejouée
        // inoffensive.
        const ordre = [...parts.keys()].sort((a, b) => a - b)
        objets.set(key, Buffer.concat(ordre.map((n) => parts.get(n) as Buffer)))
        multiparts.delete(uploadId)
        return reply.type('application/xml').send('<CompleteMultipartUploadResult/>')
      }

      if (request.method === 'DELETE' && query.has('uploadId')) {
        const uploadId = query.get('uploadId') ?? ''
        abandons.push(uploadId)
        multiparts.delete(uploadId)
        return reply.status(204).send('')
      }

      if (request.method === 'GET' && query.has('uploads')) {
        const ouverts = [...multiparts.keys()]
          .map((id) => `<Upload><Key>x</Key><UploadId>${id}</UploadId></Upload>`)
          .join('')
        return reply
          .type('application/xml')
          .send(`<ListMultipartUploadsResult><IsTruncated>false</IsTruncated>${ouverts}</ListMultipartUploadsResult>`)
      }

      return reply.status(400).send('<Error><Code>InvalidRequest</Code></Error>')
    },
  })

  return { app, objets, abandons, multiparts }
}

/**
 * Une autorité de certification fabriquée pour l'occasion, et un certificat
 * de serveur signé par elle.
 *
 * C'est le cas d'un stockage interne : Node n'a aucune raison de faire
 * confiance à cette CA — elle n'est dans aucun magasin, et Node n'utilise même
 * pas celui du système. Sans le PEM, la connexion échoue sur
 * `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.
 */
function fabriquerCa(dossier: string): { caPem: string; key: string; cert: string } {
  const ca = join(dossier, 'ca.pem')
  const caKey = join(dossier, 'ca.key')
  const srvKey = join(dossier, 'srv.key')
  const srvCsr = join(dossier, 'srv.csr')
  const srvPem = join(dossier, 'srv.pem')
  const ext = join(dossier, 'ext.cnf')
  const run = (commande: string): void => {
    execSync(commande, { stdio: 'ignore' })
  }
  run(`openssl req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes -keyout ${caKey} -out ${ca} -subj "/CN=CA interne de test" -addext "basicConstraints=critical,CA:TRUE"`)
  run(`openssl req -newkey rsa:2048 -nodes -keyout ${srvKey} -out ${srvCsr} -subj "/CN=localhost"`)
  writeFileSync(ext, 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n')
  run(`openssl x509 -req -in ${srvCsr} -CA ${ca} -CAkey ${caKey} -CAcreateserial -out ${srvPem} -days 1 -sha256 -extfile ${ext}`)
  return {
    caPem: ca,
    key: readFileSync(srvKey, 'utf8'),
    cert: readFileSync(srvPem, 'utf8'),
  }
}

let hub: Hub
let stockage: ReturnType<typeof fauxStockage>
let stockageApp: FastifyInstance
let origin: string
let dir: string
let room: RoomApp
let regie: string

const agir = async (payload: unknown) => {
  const response = await fetch(`${regie}/control/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return (await response.json()) as { ok: boolean; message?: string }
}

const uploads = async () =>
  (await (await fetch(`${regie}/control/uploads`)).json()) as {
    ok: boolean
    entries: { file: string; state: string; percent: number }[]
    verdict: { allowed: boolean; text: string }
  }

/** Attend qu'une condition se vérifie, ou rend la main : les assertions parleront. */
async function jusqua(condition: () => boolean | Promise<boolean>, limiteMs = 15_000): Promise<void> {
  const fin = Date.now() + limiteMs
  while (Date.now() < fin) {
    if (await condition()) return
    await sleep(100)
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-vod-'))

  stockage = fauxStockage()
  stockageApp = stockage.app
  await stockageApp.listen({ port: 0, host: '127.0.0.1' })
  const adresseS3 = stockageApp.server.address()
  const portS3 = typeof adresseS3 === 'object' && adresseS3 != null ? adresseS3.port : 0

  hub = await createHub({
    port: 0,
    host: '127.0.0.1',
    databasePath: ':memory:',
    publicUrl: 'http://127.0.0.1',
    authSecret: 'test-secret-'.padEnd(48, 'x'),
    logLevel: 'fatal',
    devicePollInterval: '1s',
    mode: 'dev',
    simulatedTime: new Date(PENDANT_LE_TALK).toISOString(),
    s3Endpoint: `http://127.0.0.1:${portS3}`,
    s3AccessKeyId: 'cle-de-test',
    s3SecretAccessKey: 'secret-de-test',
  })
  await hub.app.listen({ port: 0, host: '127.0.0.1' })
  const address = hub.app.server.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`

  await provisionOperator(hub.auth, OPERATOR)
  const snapshot = hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
  hub.services.rooms.ensureFromTracks(snapshot.program.rooms)

  // Le bucket se règle depuis la console : sans lui, le hub a les clés et
  // aucune destination — et c'est bien ce qu'il répond.
  hub.services.settings.update({
    vodBucket: 'rushes',
    vodPrefix: 'cn26',
    // Cinq mégaoctets est le minimum de S3 ; le rush simulé est minuscule, donc
    // il partira en un seul envoi. Le découpage, lui, est couvert ailleurs.
    vodPolitique: { taillePartMo: 5 },
  })

  let token: string | null = null
  room = new RoomApp({
    dataDir: dir,
    hubOrigin: origin,
    clientId: CLIENT_ID,
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
  await stockageApp.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Enregistre un talk : le mock OBS écrit un vrai fichier à l'arrêt.
 *
 * Puis **vieillit les fichiers produits**, et c'est nécessaire depuis que la
 * fenêtre d'écriture se juge sur l'heure du poste : un rush arrêté à l'instant
 * est, à juste titre, « encore en écriture » pendant trente secondes, et le
 * téléverseur passe son tour dessus. Ces tests-là portent sur ce qui arrive à
 * un rush **fini** ; les faire attendre une demi-minute ne dirait rien de plus.
 *
 * Ce détour ne masque rien : avant, ils ne passaient que parce que l'horloge
 * corrigée du hub — deux mois d'avance sur celle du poste, journée simulée
 * oblige — faisait paraître vieux tout ce qui venait d'être écrit. C'est
 * exactement le défaut qui montrait une prise en cours comme un rush prêt à
 * partir dans la modale VOD.
 */
async function enregistrerUnTalk(): Promise<void> {
  expect((await agir({ action: 'recording.start' })).ok).toBe(true)
  await sleep(50)
  expect((await agir({ action: 'recording.stop' })).ok).toBe(true)
  // La racine des captations est celle qu'annonce OBS-B : on laisse le temps à
  // l'arrêt de rendre son chemin, sans quoi le rush n'est pas encore listé.
  await sleep(100)
  vieillirLesRushes(join(dir, 'rec'))
}

/** Une heure en arrière sur tout le dossier : des fichiers que plus rien n'écrit. */
function vieillirLesRushes(racine: string): void {
  const jadis = new Date(Date.now() - 3_600_000)
  for (const nom of readdirSync(racine)) {
    utimesSync(join(racine, nom), jadis, jadis)
  }
}

describe('du rush au stockage', () => {
  it('téléverse rush et sidecar, octet pour octet', async () => {
    await enregistrerUnTalk()

    const liste = await room.listRecordings()
    const rush = liste.entries[0]
    expect(rush).toBeDefined()
    const surDisque = readFileSync(join(liste.root as string, rush!.file))

    expect((await agir({ action: 'vod.upload', file: rush!.file })).ok).toBe(true)
    await jusqua(async () => (await uploads()).entries.some((e) => e.state === 'termine'))

    const vue = await uploads()
    expect(vue.entries.find((e) => e.file === rush!.file)).toMatchObject({
      state: 'termine',
      percent: 100,
    })

    // La clé porte la date du **rush**, la salle, et le nom produit par OBS.
    const cle = [...stockage.objets.keys()].find((k) => k.endsWith(rush!.file))
    expect(cle).toBeDefined()
    expect(cle).toContain(`cn26/2026-10-30/${TRACK_1}/`)

    // Le seul contrôle qui compte le soir de l'événement.
    expect(stockage.objets.get(cle as string)?.equals(surDisque)).toBe(true)

    // Le sidecar suit, sous la même clé à l'extension près : le editing
    // retrouve titre, intervenants et marqueurs sans repasser par le hub.
    const cleSidecar = cle?.replace(/\.[^.]+$/, '.json')
    expect(stockage.objets.has(cleSidecar as string)).toBe(true)
    const sidecar = JSON.parse(String(stockage.objets.get(cleSidecar as string))) as {
      title: string
      videoFile: string
    }
    expect(sidecar.videoFile).toBe(rush!.file)
    expect(sidecar.title).toBeTruthy()
  })

  it('inscrit le téléversement au registre du hub, salle comprise', async () => {
    await enregistrerUnTalk()
    const liste = await room.listRecordings()
    await agir({ action: 'vod.upload', file: liste.entries[0]!.file })
    await jusqua(async () => (await uploads()).entries.some((e) => e.state === 'termine'))

    // C'est ce que la console affiche : sans cette ligne, l'organisateur ne
    // saurait pas ce qui est rapatrié et ce qui manque encore.
    const registre = hub.services.vod!.uploads(null, () => 'Track #1')
    expect(registre.some((l) => l.roomId === TRACK_1 && l.state === 'termine')).toBe(true)
    expect(registre.some((l) => l.kind === 'sidecar')).toBe(true)
  })

  it('ne remonte pas deux fois le même rush', async () => {
    await enregistrerUnTalk()
    const liste = await room.listRecordings()
    await agir({ action: 'vod.upload', file: liste.entries[0]!.file })
    await jusqua(async () => (await uploads()).entries.some((e) => e.state === 'termine'))
    const premiers = stockage.objets.size

    await agir({ action: 'vod.upload', file: null })
    await sleep(300)
    // Payer deux fois le transfert d'un rush de trois gigaoctets sur le réseau
    // de l'événement est exactement ce qu'un « Tout téléverser » cliqué deux
    // fois ne doit pas faire.
    expect(stockage.objets.size).toBe(premiers)
  })

  it('refuse de téléverser pendant un enregistrement, et dit pourquoi', async () => {
    await enregistrerUnTalk()
    const liste = await room.listRecordings()

    // On relance une captation : le disque qu'on lirait est celui qu'OBS écrit.
    await agir({ action: 'recording.start' })
    await agir({ action: 'vod.upload', file: liste.entries[0]!.file })
    await sleep(300)

    const vue = await uploads()
    expect(vue.verdict.allowed).toBe(false)
    expect(vue.verdict.text).toContain('enregistrement')
    expect(stockage.objets.size).toBe(0)

    await agir({ action: 'recording.stop' })
  })

  it('obéit à la console, qui n\'a pourtant pas les fichiers', async () => {
    await enregistrerUnTalk()

    // La demande descend par le flux de commandes, comme une resynchronisation :
    // une salle momentanément coupée la rattraperait à sa reconnexion.
    const token = await (async () => {
      const response = await fetch(`${origin}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
      })
      return ((await response.json()) as { token: string }).token
    })()
    const admin: ContractRouterClient<typeof contract> = createORPCClient(
      new RPCLink({ origin, url: '/rpc', headers: () => ({ authorization: `Bearer ${token}` }) }),
    )
    expect(await admin.vod.request({ roomId: TRACK_1, file: null })).toEqual({ ok: true })

    await jusqua(async () => (await uploads()).entries.some((e) => e.state === 'termine'))
    expect(stockage.objets.size).toBeGreaterThan(0)

    // Et la régie le signale : une salle qui se met à saturer son uplink sans
    // que personne ne l'ait demandé sur place se lirait comme un incident.
    const avis = room.runtime.state().notifications.map((n) => n.text)
    expect(avis.some((texte) => texte.includes('Rapatriement des rushes demandé'))).toBe(true)
  })

  it('n\'expose aucune clé du stockage à la salle', async () => {
    // Tout ce que la salle reçoit du hub, à plat : ni clé d'accès, ni secret.
    // Une machine de régie vit dans un couloir, allumée toute la journée.
    const brut = JSON.stringify(room.store.settings())
    expect(brut).not.toContain('secret-de-test')
    expect(brut).not.toContain('cle-de-test')
    // Elle sait seulement qu'il y a une destination, et sous quelles règles.
    expect(room.store.settings().vod?.actif).toBe(true)
  })
})

describe('quand le stockage se dérobe', () => {
  it('retient l\'erreur du stockage plutôt que de marquer « terminé »', async () => {
    await enregistrerUnTalk()
    const liste = await room.listRecordings()

    // Le bucket disparaît entre deux talks — droits révoqués, quota atteint.
    await stockageApp.close()

    await agir({ action: 'vod.upload', file: liste.entries[0]!.file })
    await jusqua(async () => (await uploads()).entries.some((e) => e.state !== 'en-cours'), 5_000)

    const vue = await uploads()
    const entree = vue.entries.find((e) => e.file === liste.entries[0]!.file)
    expect(entree?.state).not.toBe('termine')
  })
})

/**
 * Un stockage interne, derrière une autorité de certification maison.
 *
 * Le cas s'est présenté en vrai, et il est instructif : `UNABLE_TO_GET_ISSUER_
 * CERT_LOCALLY`. Node n'utilise pas le magasin de certificats du système, il
 * embarque sa propre liste de CA publiques — une CA d'entreprise n'y est pas.
 *
 * Ce que ce test protège n'est pas la ligne de code qui pose `ca`, c'est le
 * fait que **la salle n'ait rien à savoir** : la CA descend du hub au sync.
 * Poser une variable d'environnement sur trois postes Electron un matin
 * d'événement est un geste qui s'oublie sur le troisième, et l'oubli ne se
 * découvre que le soir, quand les rushes ne partent pas.
 */
describe('stockage derrière une CA interne', () => {
  let dossierCa: string
  let stockageTls: ReturnType<typeof fauxStockage>
  let appTls: FastifyInstance
  let hubTls: Hub
  let roomTls: RoomApp
  let regieTls: string
  let dirTls: string

  /** Monte la chaîne entière en HTTPS. `caCert` nul = le hub ne pousse rien. */
  async function monterTout(avecCa: boolean): Promise<void> {
    dossierCa = mkdtempSync(join(tmpdir(), 'cloudnord-ca-'))
    dirTls = mkdtempSync(join(tmpdir(), 'cloudnord-vodtls-'))
    const ca = fabriquerCa(dossierCa)

    stockageTls = fauxStockage({ key: ca.key, cert: ca.cert })
    appTls = stockageTls.app
    await appTls.listen({ port: 0, host: '127.0.0.1' })
    const adresse = appTls.server.address()
    const port = typeof adresse === 'object' && adresse != null ? adresse.port : 0

    hubTls = await createHub({
      port: 0,
      host: '127.0.0.1',
      databasePath: ':memory:',
      publicUrl: 'http://127.0.0.1',
      authSecret: 'test-secret-'.padEnd(48, 'x'),
      logLevel: 'fatal',
      devicePollInterval: '1s',
      mode: 'dev',
      simulatedTime: new Date(PENDANT_LE_TALK).toISOString(),
      s3Endpoint: `https://localhost:${port}`,
      s3AccessKeyId: 'cle-de-test',
      s3SecretAccessKey: 'secret-de-test',
      ...(avecCa ? { s3CaCert: ca.caPem } : {}),
    })
    await hubTls.app.listen({ port: 0, host: '127.0.0.1' })
    const adresseHub = hubTls.app.server.address()
    const originHub = `http://127.0.0.1:${typeof adresseHub === 'object' && adresseHub != null ? adresseHub.port : 0}`

    await provisionOperator(hubTls.auth, OPERATOR)
    const snapshot = hubTls.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
    hubTls.services.rooms.ensureFromTracks(snapshot.program.rooms)
    hubTls.services.settings.update({ vodBucket: 'rushes', vodPolitique: { taillePartMo: 5 } })

    let jeton: string | null = null
    roomTls = new RoomApp({
      dataDir: dirTls,
      hubOrigin: originHub,
      clientId: CLIENT_ID,
      roomId: TRACK_1,
      displayPort: 0,
      obsTransportFactory: (instance) =>
        createMockObsTransport({ instance, recordingDir: join(dirTls, 'rec') }),
      readToken: () => jeton,
      writeToken: (valeur) => {
        jeton = valeur
      },
      onPairingCode: (code) => {
        void (async () => {
          const reponse = await fetch(`${originHub}/api/auth/sign-in/email`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
          })
          const session = (await reponse.json()) as { token: string }
          const admin: ContractRouterClient<typeof contract> = createORPCClient(
            new RPCLink({ origin: originHub, url: '/rpc', headers: () => ({ authorization: `Bearer ${session.token}` }) }),
          )
          await admin.devices.approve({ userCode: code.user_code, clientId: CLIENT_ID, roomId: TRACK_1 })
        })()
      },
    })
    regieTls = await roomTls.startDisplay()
    const obtenu = await roomTls.ensurePaired()
    await roomTls.connectHub(obtenu!)
    await roomTls.connectObs()
    roomTls.runtime.refreshSessions()
  }

  afterEach(async () => {
    await roomTls?.close()
    await hubTls?.close().catch(() => {})
    await appTls?.close().catch(() => {})
    rmSync(dossierCa, { recursive: true, force: true })
    rmSync(dirTls, { recursive: true, force: true })
  })

  const agirTls = async (payload: unknown) => {
    const reponse = await fetch(`${regieTls}/control/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return (await reponse.json()) as { ok: boolean; message?: string }
  }

  const uploadsTls = async () =>
    (await (await fetch(`${regieTls}/control/uploads`)).json()) as {
      entries: { file: string; state: string; error: string | null }[]
    }

  async function enregistrer(): Promise<string> {
    await agirTls({ action: 'recording.start' })
    await sleep(50)
    await agirTls({ action: 'recording.stop' })
    await sleep(100)
    // Même raison qu'au-dessus : un rush arrêté à l'instant reste « encore en
    // écriture » une demi-minute, et le téléverseur passe son tour dessus.
    vieillirLesRushes(join(dirTls, 'rec'))
    const liste = await roomTls.listRecordings()
    return liste.entries[0]!.file
  }

  it('échoue clairement quand la CA n\'est pas connue', async () => {
    await monterTout(false)
    const rush = await enregistrer()

    await agirTls({ action: 'vod.upload', file: rush })
    await jusqua(async () => (await uploadsTls()).entries.some((e) => e.error != null), 8_000)

    const erreur = (await uploadsTls()).entries.find((e) => e.file === rush)?.error ?? ''
    // Le message doit nommer le défaut de confiance, pas parler de réseau : on
    // ne cherche pas un pare-feu quand il manque un certificat.
    expect(erreur).toMatch(/CERT|SIGNATURE|SELF_SIGNED/)
    expect(stockage.objets.size).toBe(0)
  })

  it('téléverse sans que la salle ait rien à connaître de la CA', async () => {
    await monterTout(true)
    const rush = await enregistrer()

    // La CA est descendue au sync, avec le reste de la politique. Aucune
    // variable d'environnement n'a été posée sur cette machine.
    expect(roomTls.store.settings().vod?.caCert).toContain('BEGIN CERTIFICATE')

    await agirTls({ action: 'vod.upload', file: rush })
    await jusqua(async () => (await uploadsTls()).entries.some((e) => e.state === 'termine'), 15_000)

    const entree = (await uploadsTls()).entries.find((e) => e.file === rush)
    expect(entree?.state).toBe('termine')
    expect(entree?.error).toBeNull()

    const cle = [...stockageTls.objets.keys()].find((k) => k.endsWith(rush))
    expect(cle).toBeDefined()
    // Et jamais la clé secrète du stockage : la salle n'a reçu qu'un certificat
    // d'autorité, qui est public par construction.
    const reglages = JSON.stringify(roomTls.store.settings())
    expect(reglages).not.toContain('secret-de-test')
  })
})

/**
 * La remise à zéro, vue de la salle.
 *
 * Ce que ces tests protègent tient en deux phrases. Une salle qui n'est pas en
 * développement **refuse** d'effacer ses rushes, même sur ordre du hub : une
 * salle de développement et un hub d'événement peuvent se retrouver branchés
 * l'un à l'autre, c'est même l'accident que le badge de mode existe pour rendre
 * visible. Et ce qui est effacé se limite à ce que l'application connaît : la
 * racine des captations est un dossier qu'un opérateur a saisi dans un
 * formulaire, parfois un disque partagé.
 */
describe('remise à zéro des rushes', () => {
  /**
   * La même salle, vue comme un poste de développement.
   *
   * `mode` n'est lu qu'au moment du geste : le retoucher ici évite de monter
   * une seconde chaîne complète — hub, appairage, OBS — pour éprouver deux
   * lignes de garde.
   */
  function enDeveloppement(): RoomApp {
    ;(room as unknown as { options: { mode: string } }).options.mode = 'dev'
    return room
  }

  async function fichiersPresents(): Promise<string[]> {
    const { readdir } = await import('node:fs/promises')
    const liste = await room.listRecordings()
    return await readdir(liste.root as string)
  }

  it('refuse d\'effacer quand la salle n\'est pas en développement', async () => {
    // Le second verrou, et la raison qu'il existe : une salle de développement
    // et un hub d'événement peuvent se retrouver branchés l'un à l'autre —
    // c'est même l'accident que le badge de mode de la régie rend visible. Le
    // hub garde son côté ; la salle garde le sien, au plus près du disque.
    await enregistrerUnTalk()
    const avant = await fichiersPresents()

    // `room` est monté sans mode : c'est-à-dire en production, le défaut.
    expect(await room.razVod()).toBe(0)
    expect(await fichiersPresents()).toEqual(avant)
  })

  it('efface les rushes, leurs sidecars et les verdicts — et rien d\'autre', async () => {
    await enregistrerUnTalk()
    const liste = await room.listRecordings()
    const racine = liste.root as string

    // Un verdict posé à la main : il vit dans `.controles-vod.json`, à la
    // racine, et décrit une relecture qui n'a plus d'objet une fois les rushes
    // partis.
    await agir({ action: 'vod.verdict', file: liste.entries[0]!.file, status: 'ok' })
    // Et un fichier que l'application n'a pas produit : le dossier de captation
    // est parfois partagé avec autre chose.
    writeFileSync(join(racine, 'notes-de-la-regie.txt'), 'à ne pas effacer')

    expect(await enDeveloppement().razVod()).toBeGreaterThan(0)

    const restants = await fichiersPresents()
    expect(restants.filter((nom) => nom.endsWith('.mkv'))).toEqual([])
    expect(restants.filter((nom) => nom.endsWith('.json'))).toEqual([])
    expect(restants).not.toContain('.controles-vod.json')
    // Ce que l'opérateur a déposé reste : vider un dossier qu'on ne possède pas
    // entièrement n'est pas un geste qu'on rattrape.
    expect(restants).toContain('notes-de-la-regie.txt')
  })

  it('oublie la file de téléversement au passage', async () => {
    await enregistrerUnTalk()
    const liste = await room.listRecordings()
    await agir({ action: 'vod.upload', file: liste.entries[0]!.file })
    await jusqua(async () => (await uploads()).entries.some((e) => e.state === 'termine'))

    await enDeveloppement().razVod()
    // Garder des lignes « terminé » qui pointent des fichiers effacés ferait
    // dire à la modale que tout est en sécurité.
    expect((await uploads()).entries).toEqual([])
  })
})
