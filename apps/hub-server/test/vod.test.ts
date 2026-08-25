import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openHubDatabase, type HubDatabase } from '../src/db.js'
import { RoomService } from '../src/services/rooms.js'
import { SettingsService } from '../src/services/sessions.js'
import { VodService, StockageIncomplet, clesS3 } from '../src/services/vod.js'
import type { TransportS3 } from '../src/services/s3.js'
import { configSchema } from '../src/config.js'
import { createHub } from '../src/server.js'
import { provisionOperator } from '../src/operators.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Le registre des téléversements, et son ménage.
 *
 * Ce qu'on tient ici : qu'un rush interrompu **reprenne** au lieu de
 * recommencer, et qu'un multipart abandonné en silence finisse par être fermé.
 * Les deux se paient au même endroit, en fin d'événement — le premier en heures
 * de réseau à refaire un fichier de trois gigaoctets déjà monté aux neuf
 * dixièmes, le second sur une facture de stockage que personne ne relira avant
 * des mois, pour des octets que plus rien ne réclame.
 *
 * Aucun vrai S3 ici : `fetch` est simulé. Ce qui compte est ce que le hub
 * décide, pas ce que le stockage répond — ça, c'est `s3.test.ts` et le test
 * bout-en-bout de la salle.
 */

const TRACK_1 = 'track-1-teilhard-de-chardin'

let db: HubDatabase
let settings: SettingsService
/** Base sur disque : l'amorce ne se prouve qu'entre deux démarrages. */
let dossier: string
let cheminBase: string

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), 'cloudnord-vod-'))
  cheminBase = join(dossier, 'hub.db')
  db = openHubDatabase(':memory:').orm
  settings = new SettingsService(db)
  const rooms = new RoomService(db)
  rooms.upsert({
    id: TRACK_1,
    name: 'Track #1',
    trackId: TRACK_1,
    obs: {
      A: { url: 'ws://127.0.0.1:4455', password: null },
      B: { url: 'ws://127.0.0.1:4456', password: null },
    },
    sceneRoles: { A: {}, B: {} },
    displayPort: 7788,
    recordingRoot: null,
  })
})

afterEach(() => {
  rmSync(dossier, { recursive: true, force: true })
})

const CLES = {
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  accessKeyId: 'cle',
  secretAccessKey: 'secret',
  forcePathStyle: true,
}

/** Un stockage qui dit toujours oui, et qui retient ce qu'on lui a demandé. */
function fauxS3(): { transport: TransportS3; appels: { url: string; method: string }[] } {
  const appels: { url: string; method: string }[] = []
  let numero = 0
  const impl: TransportS3 = async (url, options) => {
    appels.push({ url, method: options.method })
    if (url.includes('uploads=') && options.method === 'POST') {
      numero += 1
      return {
        status: 200,
        corps: `<InitiateMultipartUploadResult><UploadId>u${numero}</UploadId></InitiateMultipartUploadResult>`,
      }
    }
    if (url.includes('uploads=')) {
      return { status: 200, corps: '<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>' }
    }
    return { status: 200, corps: '<Ok/>' }
  }
  return { transport: impl, appels }
}

function service(transport: TransportS3, minutes = 30, now = () => new Date().toISOString()): VodService {
  return new VodService(db, settings, CLES, minutes, now, () => {}, transport)
}

const UN_RUSH = {
  roomId: TRACK_1,
  file: '2026-10-30_track1_1100_honeyswamp.mkv',
  sizeBytes: 40 * 1024 * 1024,
  kind: 'rush' as const,
  sessionId: 'sess-1',
}

describe('configuration', () => {
  it('n\'a pas de clés tant que les trois variables ne sont pas là', () => {
    const base = { authSecret: 'x'.repeat(40) }
    expect(clesS3(configSchema.parse(base))).toBeNull()
    expect(
      clesS3(
        configSchema.parse({
          ...base,
          s3Endpoint: 'http://localhost:9000',
          s3AccessKeyId: 'cle',
          s3SecretAccessKey: 'secret',
        }),
      ),
    ).not.toBeNull()
  })

  it('refuse de démarrer sur un stockage à moitié configuré', () => {
    // Trois sur quatre monteraient un hub où la console annonce un stockage
    // prêt et où chaque téléversement échoue à la signature : on chercherait la
    // panne dans les droits du bucket, pas dans un `.env` amputé d'une ligne.
    expect(() =>
      configSchema.parse({
        authSecret: 'x'.repeat(40),
        s3Endpoint: 'http://localhost:9000',
        s3AccessKeyId: 'cle',
      }),
    ).toThrow()
  })

  it('amorce le bucket depuis l\'environnement, une seule fois', async () => {
    // Le cas d'un hub provisionné d'avance, où personne n'ouvrira la console
    // avant l'événement : sans amorce, il démarrerait avec ses clés et aucune
    // destination.
    const premier = await createHub({
      port: 0,
      host: '127.0.0.1',
      databasePath: cheminBase,
      publicUrl: 'http://127.0.0.1',
      authSecret: 'test-secret-'.padEnd(48, 'x'),
      logLevel: 'fatal',
      s3Endpoint: 'http://localhost:9000',
      s3AccessKeyId: 'cle',
      s3SecretAccessKey: 'secret',
      s3Bucket: 'rushes-amorce',
    })
    expect(premier.services.settings.get().vodBucket).toBe('rushes-amorce')
    // Et le hub s'annonce prêt du premier coup : amorcer plus tard lui aurait
    // fait dire « aucun bucket réglé » sur une installation pourtant complète.
    expect(premier.services.vod?.pret()).toBe(true)

    // La console corrige — on visait le bucket de l'an dernier.
    premier.services.settings.update({ vodBucket: 'rushes-2027' })
    await premier.close()

    const second = await createHub({
      port: 0,
      host: '127.0.0.1',
      databasePath: cheminBase,
      publicUrl: 'http://127.0.0.1',
      authSecret: 'test-secret-'.padEnd(48, 'x'),
      logLevel: 'fatal',
      s3Endpoint: 'http://localhost:9000',
      s3AccessKeyId: 'cle',
      s3SecretAccessKey: 'secret',
      s3Bucket: 'rushes-amorce',
    })
    // Le redémarrage ne réécrase pas : une correction faite en cours
    // d'événement doit y survivre, et c'est précisément ce jour-là qu'on
    // relance le hub.
    expect(second.services.settings.get().vodBucket).toBe('rushes-2027')
    await second.close()
  })

  it('a des clés mais n\'est pas prêt tant qu\'aucun bucket n\'est réglé', () => {
    const vod = service(fauxS3().transport)
    expect(vod.pret()).toBe(false)
    // C'est l'état le plus déroutant des trois : les clés sont là, la console
    // montre le panneau, et rien ne part. Le message doit dire où aller.
    expect(() => vod.parts(TRACK_1, 'inconnu', [1])).toThrow(StockageIncomplet)

    settings.update({ vodBucket: 'rushes' })
    expect(vod.pret()).toBe(true)
  })
})

describe('ouverture et reprise', () => {
  beforeEach(() => {
    settings.update({ vodBucket: 'rushes', vodPrefix: 'cn26' })
  })

  it('range sous la date du fichier, pas sous celle du rapatriement', async () => {
    const vod = service(fauxS3().transport, 30, () => '2026-11-05T09:00:00.000Z')
    // Le rush est du 30 octobre ; on le rapatrie le 5 novembre. Le ranger sous
    // la date du transfert le rendrait introuvable pour qui cherche la journée.
    expect(vod.cleObjet(TRACK_1, UN_RUSH.file)).toBe(
      `cn26/2026-10-30/${TRACK_1}/2026-10-30_track1_1100_honeyswamp.mkv`,
    )
    // Un nom sans date — ce qu'OBS produit quand la salle n'a jamais synchronisé
    // — retombe sur l'heure du hub plutôt que sur rien.
    expect(vod.cleObjet(TRACK_1, 'rush-sans-date.mkv')).toBe(
      `cn26/2026-11-05/${TRACK_1}/rush-sans-date.mkv`,
    )
  })

  it('découpe un rush en parts et un sidecar en un seul envoi', async () => {
    const vod = service(fauxS3().transport)
    settings.update({ vodPolitique: { taillePartMo: 8 } })

    const plan = await vod.begin(UN_RUSH)
    expect(plan.mode).toBe('multipart')
    if (plan.mode !== 'multipart') throw new Error('inattendu')
    expect(plan.taillePartOctets).toBe(8 * 1024 * 1024)
    expect(plan.parts).toBe(5)
    expect(plan.recues).toEqual([])

    // Le sidecar pèse quelques kilo-octets : ouvrir un multipart pour lui
    // coûterait trois requêtes là où une suffit.
    const sidecar = await vod.begin({
      ...UN_RUSH,
      file: '2026-10-30_track1_1100_honeyswamp.json',
      sizeBytes: 900,
      kind: 'sidecar',
    })
    expect(sidecar.mode).toBe('direct')
  })

  it('reprend là où la salle s\'était arrêtée, sans rouvrir de multipart', async () => {
    const faux = fauxS3()
    const vod = service(faux.transport)

    const plan = await vod.begin(UN_RUSH)
    if (plan.mode !== 'multipart') throw new Error('inattendu')
    vod.progress({ roomId: TRACK_1, uploadId: plan.uploadId, numero: 1, etag: '"a"', octets: 8_388_608, dureeMs: 2000 })
    vod.progress({ roomId: TRACK_1, uploadId: plan.uploadId, numero: 2, etag: '"b"', octets: 8_388_608, dureeMs: 2000 })

    const ouvertures = faux.appels.filter((a) => a.method === 'POST' && a.url.includes('uploads=')).length

    // La machine redémarre : elle redemande son plan.
    const repris = await vod.begin(UN_RUSH)
    if (repris.mode !== 'multipart') throw new Error('inattendu')
    expect(repris.uploadId).toBe(plan.uploadId)
    expect(repris.recues).toEqual([1, 2])
    // Et surtout : aucun second multipart. En rouvrir un abandonnerait seize
    // mégaoctets déjà chez le stockage, et sur un rush de trois gigaoctets une
    // machine qui redémarre deux fois ne finirait jamais.
    expect(faux.appels.filter((a) => a.method === 'POST' && a.url.includes('uploads=')).length).toBe(
      ouvertures,
    )
  })

  it('repart de zéro quand le fichier a changé de taille sous le même nom', async () => {
    const vod = service(fauxS3().transport)
    const plan = await vod.begin(UN_RUSH)
    if (plan.mode !== 'multipart') throw new Error('inattendu')
    vod.progress({ roomId: TRACK_1, uploadId: plan.uploadId, numero: 1, etag: '"a"', octets: 1000, dureeMs: 10 })

    // Ce n'est plus le même rush : reprendre collerait la fin d'un fichier sur
    // le début d'un autre, et le résultat s'ouvrirait sans qu'on voie le défaut.
    const autre = await vod.begin({ ...UN_RUSH, sizeBytes: UN_RUSH.sizeBytes + 4096 })
    if (autre.mode !== 'multipart') throw new Error('inattendu')
    expect(autre.recues).toEqual([])
  })

  it('ne recompte pas deux fois une part rejouée', async () => {
    const vod = service(fauxS3().transport)
    const plan = await vod.begin(UN_RUSH)
    if (plan.mode !== 'multipart') throw new Error('inattendu')

    const part = { roomId: TRACK_1, uploadId: plan.uploadId, numero: 1, octets: 8_388_608, dureeMs: 1000 }
    vod.progress({ ...part, etag: '"raté"' })
    vod.progress({ ...part, etag: '"bon"' })

    const [ligne] = vod.uploads(TRACK_1, () => 'Track #1')
    // Cumuler ferait dépasser la taille du fichier, et la console afficherait 112 %.
    expect(ligne?.bytesSent).toBe(8 * 1024 * 1024)
    // Et c'est le dernier ETag qui compte : le stockage refuserait l'ancien.
    await vod.complete(TRACK_1, plan.uploadId)
  })

  it('borne une salle à ses propres téléversements', async () => {
    const vod = service(fauxS3().transport)
    const plan = await vod.begin(UN_RUSH)
    // Le `roomId` vient du jeton : une salle qui devinerait l'identifiant d'un
    // téléversement voisin ne doit rien pouvoir en faire.
    expect(() => vod.parts('autre-salle', plan.uploadId, [1])).toThrow(StockageIncomplet)
  })
})

describe('ménage', () => {
  beforeEach(() => {
    settings.update({ vodBucket: 'rushes' })
  })

  it('abandonne ce qui ne progresse plus, et ferme le multipart chez le stockage', async () => {
    const faux = fauxS3()
    const vieux = new Date(Date.now() - 90 * 60_000).toISOString()
    // Ouvert il y a une heure et demie, puis plus rien : la salle a été éteinte
    // en pleine montée, et elle ne dira jamais qu'elle renonce.
    const vod = service(faux.transport, 30, () => vieux)
    await vod.begin(UN_RUSH)

    const enCours = service(faux.transport, 30)
    expect(await enCours.menageUneFois()).toBe(1)
    expect(faux.appels.some((a) => a.method === 'DELETE')).toBe(true)

    const [ligne] = enCours.uploads(TRACK_1, () => null)
    expect(ligne?.state).toBe('abandonne')
    expect(ligne?.lastError).toContain('30 min')
  })

  it('laisse tranquille ce qui progresse encore', async () => {
    const faux = fauxS3()
    const vod = service(faux.transport, 30)
    await vod.begin(UN_RUSH)
    expect(await vod.menageUneFois()).toBe(0)
    expect(faux.appels.some((a) => a.method === 'DELETE')).toBe(false)
  })

  it('ferme les multiparts orphelins d\'une base recréée, mais pas les récents', async () => {
    const vieux = new Date(Date.now() - 48 * 3600_000).toISOString()
    const recent = new Date(Date.now() - 3600_000).toISOString()
    const supprimes: string[] = []
    const impl: TransportS3 = async (url, options) => {
      if (options.method === 'DELETE') supprimes.push(url)
      if (options.method === 'GET') {
        return {
          status: 200,
          corps:
            '<ListMultipartUploadsResult><IsTruncated>false</IsTruncated>' +
            `<Upload><Key>a.mkv</Key><UploadId>orphelin</UploadId><Initiated>${vieux}</Initiated></Upload>` +
            `<Upload><Key>b.mkv</Key><UploadId>recent</UploadId><Initiated>${recent}</Initiated></Upload>` +
            '<Upload><Key>c.mkv</Key><UploadId>sans-date</UploadId></Upload>' +
            '</ListMultipartUploadsResult>',
        }
      }
      return { status: 200, corps: '<Ok/>' }
    }
    const vod = service(impl)

    expect(await vod.menageDesOrphelins()).toBe(1)
    expect(supprimes).toHaveLength(1)
    expect(supprimes[0]).toContain('uploadId=orphelin')
    // `recent` peut être en cours d'alimentation par une salle ; `sans-date` ne
    // dit rien de son âge. Dans les deux cas, laisser traîner coûte moins cher
    // que de couper un rush qui monte.
  })

  it('ne touche pas aux multiparts que le registre connaît encore', async () => {
    const faux = fauxS3()
    const vod = service(faux.transport)
    const plan = await vod.begin(UN_RUSH)
    if (plan.mode !== 'multipart') throw new Error('inattendu')

    const vieux = new Date(Date.now() - 48 * 3600_000).toISOString()
    const impl: TransportS3 = async (_url, options) => {
      if (options.method === 'GET') {
        return {
          status: 200,
          corps:
            '<ListMultipartUploadsResult><IsTruncated>false</IsTruncated>' +
            `<Upload><Key>a.mkv</Key><UploadId>u1</UploadId><Initiated>${vieux}</Initiated></Upload>` +
            '</ListMultipartUploadsResult>',
        }
      }
      return { status: 200, corps: '<Ok/>' }
    }
    const menage = service(impl)
    // `u1` est celui que la salle alimente : le fermer sous elle est exactement
    // ce que l'inventaire ne doit jamais faire.
    expect(await menage.menageDesOrphelins()).toBe(0)
  })

  it('ne fait rien tant qu\'aucun bucket n\'est réglé', async () => {
    settings.update({ vodBucket: null })
    const faux = fauxS3()
    const vod = service(faux.transport)
    expect(await vod.menageUneFois()).toBe(0)
    expect(await vod.menageDesOrphelins()).toBe(0)
    expect(faux.appels).toHaveLength(0)
  })
})

/**
 * Ce que dit le hub quand le stockage ne répond pas.
 *
 * Le cas s'est produit en vrai, et il a coûté un aller-retour : cinq rushes
 * mis en file un soir d'événement, deux messages différents — « Internal Server
 * Error » sur l'un, « fetch failed » sur l'autre — pour une seule et même
 * cause, un stockage éteint. Ni l'un ni l'autre ne nommait l'adresse qu'on
 * avait essayé de joindre, et l'on a cherché la panne dans le hub.
 *
 * Rien de ce que font ces procédures n'est jamais la faute du hub : elles
 * appellent un service tiers. Le message doit dire lequel, et pourquoi il n'a
 * pas répondu.
 */
describe('stockage injoignable', () => {
  let PORT_FERME = 0

  beforeAll(async () => {
    const { createServer } = await import('node:net')
    const serveur = createServer()
    await new Promise<void>((ok) => serveur.listen(0, '127.0.0.1', ok))
    PORT_FERME = (serveur.address() as { port: number }).port
    await new Promise<void>((ok) => serveur.close(() => ok()))
  })

  const config = () => ({
    port: 0,
    host: '127.0.0.1',
    databasePath: ':memory:',
    publicUrl: 'http://127.0.0.1',
    authSecret: 'test-secret-'.padEnd(48, 'x'),
    logLevel: 'fatal' as const,
    // Port fermé, volontairement : c'est exactement « MinIO n'est pas lancé ».
    // Choisi en ouvrant puis refermant un serveur, pour être sûr qu'il refuse
    // au lieu d'accepter en silence — le port 9 « discard » accepte, et le test
    // attendait alors son délai de garde au lieu de constater un refus.
    s3Endpoint: `http://127.0.0.1:${PORT_FERME}`,
    s3AccessKeyId: 'cle',
    s3SecretAccessKey: 'secret',
    s3Bucket: 'rushes',
  })

  it('rend un 502 qui nomme le stockage, et jamais un 500', async () => {
    const hub = await createHub(config())
    await hub.app.listen({ port: 0, host: '127.0.0.1' })
    const adresse = hub.app.server.address()
    const origin = `http://127.0.0.1:${typeof adresse === 'object' && adresse != null ? adresse.port : 0}`

    await provisionOperator(hub.auth, {
      email: 'regie@cloudnord.fr',
      name: 'Régie',
      password: 'motdepasse-regie-2026',
    })
    const snapshot = hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
    hub.services.rooms.ensureFromTracks(snapshot.program.rooms)
    hub.services.devices.bind({ clientId: CLIENT_ID, roomId: TRACK_1, approvedByUserId: 'op' })
    const jeton = hub.services.devices.issueToken(CLIENT_ID)

    const reponse = await fetch(`${origin}/rpc/vod/begin`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${jeton}`,
        'x-room-client-id': CLIENT_ID,
      },
      body: JSON.stringify({
        json: { file: 'gros.mkv', sizeBytes: 500 * 1024 * 1024, kind: 'rush', sessionId: null },
      }),
    })
    const corps = (await reponse.json()) as { json?: { message?: string }; message?: string }
    await hub.close()

    // 502 et non 500 : le hub n'est pas en panne, son stockage ne répond pas.
    // Les deux ne s'investiguent pas au même endroit.
    expect(reponse.status).toBe(502)
    const message = corps.json?.message ?? corps.message ?? ''
    expect(message).toContain('Stockage injoignable')
    // L'adresse visée, sans laquelle on ne sait même pas si c'est la bonne.
    expect(message).toContain(`127.0.0.1:${PORT_FERME}`)
    // Et le motif errno, qui distingue un service éteint d'un nom introuvable.
    expect(message).toMatch(/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed/)
  })
})

/**
 * Le bouton « Éprouver la connexion ».
 *
 * Il existe parce que la mise en service s'est faite à l'aveugle : on pose
 * quatre variables, on croise les doigts, et le verdict tombe des heures plus
 * tard sur cinq rushes qui ne partent pas. Ce que ce test protège, c'est qu'un
 * échec dise **où** il s'arrête : un pare-feu, une clé, un droit sur le bucket
 * et une signature ne se corrigent pas au même endroit, et « ça ne marche pas »
 * est précisément ce qu'on savait déjà.
 */
describe('éprouver la connexion', () => {
  const etape = (controle: Awaited<ReturnType<VodService['check']>>, nom: string) =>
    controle.etapes.find((e) => e.nom === nom)

  it('franchit les quatre étapes et ne laisse rien derrière', async () => {
    settings.update({ vodBucket: 'rushes', vodPrefix: 'cn26' })
    const faux = fauxS3()
    const controle = await service(faux.transport).check()

    expect(controle.ok).toBe(true)
    expect(controle.etapes.map((e) => e.nom)).toEqual([
      'joindre',
      'authentifier',
      'signer',
      'nettoyer',
    ])
    // Le multipart de contrôle est refermé : en laisser un ouvert par contrôle
    // serait un comble pour une fonctionnalité dont la moitié est un ménage.
    expect(faux.appels.some((a) => a.method === 'DELETE')).toBe(true)
    // Et l'objet de contrôle se reconnaît au nom, si jamais un abandon échoue.
    expect(faux.appels.some((a) => a.url.includes('.controle-de-connexion'))).toBe(true)
  })

  it('s\'arrête à « joindre » quand le stockage ne répond pas, sans accuser les clés', async () => {
    settings.update({ vodBucket: 'rushes' })
    const injoignable: TransportS3 = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    }
    const controle = await service(injoignable).check()

    expect(controle.ok).toBe(false)
    expect(etape(controle, 'joindre')?.ok).toBe(false)
    expect(etape(controle, 'joindre')?.detail).toContain('ECONNREFUSED')
    // Surtout : on ne prétend pas savoir si les clés sont bonnes. On n'a pas pu
    // le demander.
    expect(etape(controle, 'authentifier')).toBeUndefined()
  })

  it('nomme un certificat qu\'on ne sait pas vérifier', async () => {
    // Le cas d'une CA interne oubliée : la panne n'est pas réseau, et la
    // chercher dans un pare-feu coûte une heure.
    settings.update({ vodBucket: 'rushes' })
    const sansCa: TransportS3 = async () => {
      throw Object.assign(new Error('fetch failed'), {
        cause: Object.assign(new Error('unable to get local issuer certificate'), {
          code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
        }),
      })
    }
    const controle = await service(sansCa).check()
    expect(etape(controle, 'joindre')?.detail).toContain('UNABLE_TO_GET_ISSUER_CERT_LOCALLY')
  })

  it('distingue un stockage joignable d\'une clé refusée', async () => {
    settings.update({ vodBucket: 'rushes' })
    const refuse: TransportS3 = async (_url, options) => {
      if (options.method === 'GET') return { status: 403, corps: '' }
      return {
        status: 403,
        corps: '<Error><Code>SignatureDoesNotMatch</Code><Message>nope</Message></Error>',
      }
    }
    const controle = await service(refuse).check()

    // Joindre a réussi : le refus nu de l'étape 1 prouve déjà que le réseau
    // passe, que le nom résout et que le certificat est accepté.
    expect(etape(controle, 'joindre')?.ok).toBe(true)
    expect(etape(controle, 'authentifier')?.ok).toBe(false)
    expect(etape(controle, 'authentifier')?.detail).toContain('SignatureDoesNotMatch')
  })

  it('distingue un bucket absent d\'un bucket où l\'on ne peut pas écrire', async () => {
    settings.update({ vodBucket: 'rushes' })
    for (const [code, attendu] of [
      ['NoSuchBucket', 'NoSuchBucket'],
      ['AccessDenied', 'AccessDenied'],
    ]) {
      const transport: TransportS3 = async (_url, options) =>
        options.method === 'GET'
          ? { status: 403, corps: '' }
          : { status: 403, corps: `<Error><Code>${code}</Code><Message>x</Message></Error>` }
      const controle = await service(transport).check()
      expect(etape(controle, 'authentifier')?.detail).toContain(attendu)
    }
  })

  it('attrape une adresse signée refusée, et referme quand même', async () => {
    // L'étape la plus délicate, et celle qu'aucune sonde de lecture ne
    // couvrirait : une clé peut être valide et la signature d'une adresse de
    // part fausse. C'est elle qui porte tout le téléversement d'un rush.
    settings.update({ vodBucket: 'rushes' })
    const abandons: string[] = []
    const transport: TransportS3 = async (url, options) => {
      if (options.method === 'DELETE') abandons.push(url)
      if (options.method === 'PUT') return { status: 403, corps: '' }
      if (options.method === 'POST' && url.includes('uploads=')) {
        return { status: 200, corps: '<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>' }
      }
      return { status: 200, corps: '<Ok/>' }
    }
    const controle = await service(transport).check()

    expect(etape(controle, 'signer')?.ok).toBe(false)
    // Le multipart ouvert par le contrôle raté est refermé : sinon chaque clic
    // sur le bouton laisserait un multipart facturé derrière lui.
    expect(abandons).toHaveLength(1)
    expect(etape(controle, 'nettoyer')?.ok).toBe(true)
  })

  it('nomme l\'action S3 manquante sur un refus de droits', async () => {
    /**
     * Le cas rencontré en vrai, et il a coûté un aller-retour : une policy
     * complète pour la lecture et l'écriture, mais sans
     * `s3:AbortMultipartUpload`. Le contrôle disait « AccessDenied » et l'on
     * relisait la policy sans savoir ce qu'on y cherchait — d'autant que
     * `s3:PutObject` couvre l'ouverture d'un multipart et l'envoi des parts,
     * mais **pas** leur abandon, ce qui n'a rien d'évident.
     */
    settings.update({ vodBucket: 'rushes' })
    const policy: TransportS3 = async (url, options) => {
      const refuse = options.method === 'DELETE' && url.includes('uploadId=')
      if (refuse) {
        return { status: 403, corps: '<Error><Code>AccessDenied</Code><Message>refus</Message></Error>' }
      }
      if (options.method === 'POST' && url.includes('uploads=')) {
        return { status: 200, corps: '<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>' }
      }
      return { status: 200, corps: '<Ok/>' }
    }
    const controle = await service(policy).check()

    // Tout passe jusqu'au nettoyage : c'est bien une permission de plus qui
    // manque, pas des clés fausses.
    expect(etape(controle, 'authentifier')?.ok).toBe(true)
    expect(etape(controle, 'signer')?.ok).toBe(true)
    const nettoyer = etape(controle, 'nettoyer')
    expect(nettoyer?.ok).toBe(false)
    // Le code du stockage, et l'action à ajouter : une enquête devient une
    // ligne à écrire.
    expect(nettoyer?.detail).toContain('AccessDenied')
    expect(nettoyer?.detail).toContain('s3:AbortMultipartUpload')
  })

  it('refuse de commencer sans bucket, et le dit là où on peut le corriger', async () => {
    settings.update({ vodBucket: null })
    const controle = await service(fauxS3().transport).check()
    expect(controle.ok).toBe(false)
    expect(etape(controle, 'joindre')?.detail).toContain('aucun bucket')
  })
})

/**
 * La remise à zéro, et ce qui l'empêche de partir toute seule.
 *
 * C'est le seul geste du système dont on ne revient pas : une journée de
 * captation, effacée des deux côtés. Ce que ces tests protègent n'est donc pas
 * qu'elle marche — c'est qu'elle **refuse** dans les trois cas où elle
 * détruirait plus que ce qu'on lui a demandé.
 */
describe('remise à zéro', () => {
  it('refuse sans préfixe, plutôt que de vider le bucket entier', async () => {
    // Sans préfixe, « vider le préfixe » et « vider le bucket » sont le même
    // geste. Un bucket qui sert aussi à autre chose y passerait, et refuser est
    // le seul des deux comportements qui se rattrape.
    settings.update({ vodBucket: 'rushes', vodPrefix: null })
    const faux = fauxS3()
    await expect(service(faux.transport).raz()).rejects.toThrow(StockageIncomplet)
    // Et surtout : rien n'a été tenté.
    expect(faux.appels).toHaveLength(0)
  })

  it('supprime sous le préfixe, et abandonne les téléversements en cours', async () => {
    settings.update({ vodBucket: 'rushes', vodPrefix: 'cn26' })
    const supprimes: string[] = []
    const abandons: string[] = []
    const transport: TransportS3 = async (url, options) => {
      if (options.method === 'DELETE' && url.includes('uploadId=')) abandons.push(url)
      else if (options.method === 'DELETE') supprimes.push(url)
      if (options.method === 'GET' && url.includes('list-type=2')) {
        return {
          status: 200,
          corps:
            '<ListBucketResult><IsTruncated>false</IsTruncated>' +
            '<Contents><Key>cn26/2026-10-30/track-1/a.mkv</Key></Contents>' +
            '<Contents><Key>cn26/2026-10-30/track-1/a.json</Key></Contents>' +
            '</ListBucketResult>',
        }
      }
      if (options.method === 'GET' && url.includes('uploads=')) {
        return {
          status: 200,
          corps:
            '<ListMultipartUploadsResult><IsTruncated>false</IsTruncated>' +
            '<Upload><Key>cn26/b.mkv</Key><UploadId>u9</UploadId></Upload>' +
            '</ListMultipartUploadsResult>',
        }
      }
      return { status: 200, corps: '<Ok/>' }
    }

    const bilan = await service(transport).raz()

    expect(bilan).toEqual({ objets: 2, multiparts: 1 })
    expect(supprimes).toHaveLength(2)
    // Les multiparts ouverts ne figurent dans aucune liste d'objets — ils
    // n'existent pas encore comme objets — et survivraient donc à une remise à
    // zéro qui prétend tout effacer.
    expect(abandons).toHaveLength(1)
    expect(abandons[0]).toContain('uploadId=u9')
  })

  it('ne demande que ce qui est sous le préfixe', async () => {
    settings.update({ vodBucket: 'rushes', vodPrefix: 'cn26' })
    const faux = fauxS3()
    await service(faux.transport).raz()

    // La barre finale compte : « cn26 » sans elle attraperait aussi « cn2600 ».
    const listages = faux.appels.filter((a) => a.method === 'GET')
    expect(listages.length).toBeGreaterThan(0)
    for (const appel of listages) expect(appel.url).toContain('prefix=cn26%2F')
  })

  it('vide le registre : « terminé » sur un objet supprimé serait un mensonge', async () => {
    settings.update({ vodBucket: 'rushes', vodPrefix: 'cn26' })
    const faux = fauxS3()
    const vod = service(faux.transport)
    const plan = await vod.begin(UN_RUSH)
    await vod.complete(TRACK_1, plan.uploadId)
    expect(vod.uploads(null, () => null)).toHaveLength(1)

    await vod.raz()
    // Sinon la console continuerait d'annoncer que tout est rapatrié, sur des
    // objets qui n'existent plus.
    expect(vod.uploads(null, () => null)).toEqual([])
  })
})

/**
 * Les verrous de la remise à zéro, au niveau du hub.
 *
 * Trois, et chacun couvre ce que les autres laissent passer : la console ne
 * rend pas le bouton en production, le hub refuse la procédure, et le contrat
 * exige le mot recopié. Le premier ne protège que de l'étourderie ; les deux
 * autres protègent d'un appel direct.
 */
describe('remise à zéro : les verrous', () => {
  const base = {
    port: 0,
    host: '127.0.0.1',
    databasePath: ':memory:',
    publicUrl: 'http://127.0.0.1',
    authSecret: 'test-secret-'.padEnd(48, 'x'),
    logLevel: 'fatal' as const,
    s3Endpoint: 'http://127.0.0.1:9000',
    s3AccessKeyId: 'cle',
    s3SecretAccessKey: 'secret',
    s3Bucket: 'rushes',
  }

  async function appeler(mode: 'dev' | 'production', confirmation: string) {
    const hub = await createHub({ ...base, mode })
    await hub.app.listen({ port: 0, host: '127.0.0.1' })
    const adresse = hub.app.server.address()
    const origin = `http://127.0.0.1:${typeof adresse === 'object' && adresse != null ? adresse.port : 0}`
    await provisionOperator(hub.auth, {
      email: 'regie@cloudnord.fr',
      name: 'Régie',
      password: 'motdepasse-regie-2026',
    })
    const connexion = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'regie@cloudnord.fr', password: 'motdepasse-regie-2026' }),
    })
    const { token } = (await connexion.json()) as { token: string }
    const reponse = await fetch(`${origin}/rpc/vod/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ json: { confirmation } }),
    })
    const corps = (await reponse.json()) as { json?: { message?: string }; message?: string }
    await hub.close()
    return { status: reponse.status, message: corps.json?.message ?? corps.message ?? '' }
  }

  it('refuse en production, même avec le mot juste', async () => {
    // Le verrou qui compte : une console qui ne rend pas le bouton ne protège
    // que de l'étourderie, pas d'un appel direct. Celui-ci détruit une journée
    // de captation.
    const resultat = await appeler('production', 'RAZ')
    expect(resultat.status).toBe(403)
    expect(resultat.message).toContain('développement')
  })

  it('refuse sans le mot recopié, même en développement', async () => {
    // La confirmation est dans le contrat, donc vérifiée par le hub : un appel
    // direct qui court-circuite la modale ne peut pas se faire par distraction.
    const resultat = await appeler('dev', 'oui')
    expect(resultat.status).toBe(400)
  })
})

/**
 * Le contrôle, contre un vrai serveur TLS derrière une CA maison.
 *
 * Les tests d'à côté simulent le transport : ils prouvent la logique des
 * étapes, et **ne peuvent pas voir** qu'un appel oublie de passer la CA — le
 * faux transport n'en a que faire. C'est exactement le défaut qui est passé :
 * la sonde de joignabilité ne transmettait pas `caCert`, et le contrôle
 * accusait un certificat que la configuration corrigeait déjà.
 *
 * Un diagnostic qui accuse ce qu'on vient de réparer est pire que pas de
 * diagnostic : on défait la bonne configuration pour en chercher une autre.
 */
describe('contrôle contre un vrai TLS', () => {
  let dossier: string
  let serveur: import('node:https').Server
  let port = 0
  let caPem = ''

  beforeAll(async () => {
    const { execSync } = await import('node:child_process')
    const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { createServer } = await import('node:https')

    dossier = mkdtempSync(join(tmpdir(), 'cloudnord-ca-'))
    const chemin = (nom: string) => join(dossier, nom)
    const run = (commande: string) => execSync(commande, { stdio: 'ignore' })
    run(`openssl req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes -keyout ${chemin('ca.key')} -out ${chemin('ca.pem')} -subj "/CN=CA interne de test" -addext "basicConstraints=critical,CA:TRUE"`)
    run(`openssl req -newkey rsa:2048 -nodes -keyout ${chemin('srv.key')} -out ${chemin('srv.csr')} -subj "/CN=localhost"`)
    writeFileSync(chemin('ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n')
    run(`openssl x509 -req -in ${chemin('srv.csr')} -CA ${chemin('ca.pem')} -CAkey ${chemin('ca.key')} -CAcreateserial -out ${chemin('srv.pem')} -days 1 -sha256 -extfile ${chemin('ext.cnf')}`)
    caPem = readFileSync(chemin('ca.pem'), 'utf8')

    // Un stockage minimal : il refuse tout, ce qui suffit — l'étape « joindre »
    // se contente d'un refus, il prouve déjà que la connexion s'établit.
    serveur = createServer(
      { key: readFileSync(chemin('srv.key')), cert: readFileSync(chemin('srv.pem')) },
      (_requete, reponse) => {
        reponse.writeHead(403)
        reponse.end('<Error><Code>AccessDenied</Code><Message>refus</Message></Error>')
      },
    )
    await new Promise<void>((ok) => serveur.listen(0, '127.0.0.1', ok))
    port = (serveur.address() as { port: number }).port
  })

  afterAll(async () => {
    await new Promise<void>((ok) => serveur.close(() => ok()))
    const { rmSync } = await import('node:fs')
    rmSync(dossier, { recursive: true, force: true })
  })

  const clesTls = (caCert: string | null) => ({
    endpoint: `https://localhost:${port}`,
    region: 'us-east-1',
    accessKeyId: 'cle',
    secretAccessKey: 'secret',
    forcePathStyle: true,
    caCert,
  })

  it('franchit « joindre » quand la CA est fournie', async () => {
    settings.update({ vodBucket: 'rushes', vodPrefix: 'cn26' })
    const vod = new VodService(db, settings, clesTls(caPem), 30, () => new Date().toISOString())
    const controle = await vod.check()

    // C'est la régression : sans la CA transmise à la sonde, cette étape
    // échouait alors même que le hub était correctement configuré.
    const joindre = controle.etapes.find((e) => e.nom === 'joindre')
    expect(joindre?.ok).toBe(true)
    // Le serveur refuse tout : on s'arrête donc à l'étape suivante, ce qui est
    // le bon comportement — et prouve qu'on est bien allé lui parler.
    expect(controle.etapes.find((e) => e.nom === 'authentifier')?.ok).toBe(false)
  })

  it('sans CA, dit le défaut de confiance ET où le réparer', async () => {
    settings.update({ vodBucket: 'rushes', vodPrefix: 'cn26' })
    const vod = new VodService(db, settings, clesTls(null), 30, () => new Date().toISOString())
    const controle = await vod.check()

    const joindre = controle.etapes.find((e) => e.nom === 'joindre')
    expect(joindre?.ok).toBe(false)
    // Le code brut est conservé — c'est le seul mot qu'on puisse mettre dans un
    // moteur de recherche. Lequel exactement dépend de la chaîne que présente le
    // serveur (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`,
    // `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN`…) : ce qui
    // compte est qu'il soit là, et qu'il ne parte pas seul.
    expect(joindre?.detail).toMatch(/CERT|SIGNATURE/)
    // Car seul, il ne dit ni que Node ignore le magasin du système, ni où poser
    // la CA — et l'on cherche alors un pare-feu.
    expect(joindre?.detail).toContain('S3_CA_CERT')
  })

  it('distingue « aucune CA » de « la CA ne couvre pas ce certificat »', async () => {
    // Deux pistes opposées : dans un cas il en manque une, dans l'autre celle
    // qu'on a fournie n'est pas la bonne. Les confondre fait défaire une
    // configuration correcte pour en chercher une autre.
    settings.update({ vodBucket: 'rushes', vodPrefix: 'cn26' })
    const { execSync } = await import('node:child_process')
    const { mkdtempSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const autre = mkdtempSync(join(tmpdir(), 'cloudnord-ca2-'))
    execSync(
      `openssl req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes -keyout ${join(autre, 'k')} -out ${join(autre, 'c')} -subj "/CN=Une autre CA"`,
      { stdio: 'ignore' },
    )
    const vod = new VodService(
      db,
      settings,
      clesTls(readFileSync(join(autre, 'c'), 'utf8')),
      30,
      () => new Date().toISOString(),
    )
    const controle = await vod.check()

    expect(controle.etapes.find((e) => e.nom === 'joindre')?.detail).toContain('ne couvre pas')
  })
})
