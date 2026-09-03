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
import type { ObsInstance } from '@cloudnord/contract'
import type { DisplayPayload } from '../src/core/display-server.js'

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'motdepasse-regie-2026' }
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'
const TRACK_1 = 'track-1-teilhard-de-chardin'

function fakeObsPair(recDir: string) {
  // Le faux OBS n'écoute qu'à son adresse : une adresse fausse doit échouer
  // comme la vraie le ferait, sinon rien ne vérifie ce que voit l'opérateur
  // quand il se trompe de port.
  const make = (scenes: string[], adresse: string): ObsTransport => {
    const handlers = new Map<string, ((p: unknown) => void)[]>()
    let current = scenes[1] ?? scenes[0]!
    const emit = (event: string, payload: unknown) => {
      for (const h of handlers.get(event) ?? []) h(payload)
    }
    return {
      connect: async (url: string) => {
        if (url !== adresse) throw new Error('connect ECONNREFUSED ' + url)
      },
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
  /**
   * Par instance, jamais par ordre d'appel : une reconnexion — celle que
   * provoque un changement de configuration — recrée les deux contrôleurs, et
   * un compteur aurait donné à OBS-A les scènes d'OBS-B.
   */
  return (instance: ObsInstance) =>
    instance === 'A'
      ? make(['Capture HDMI', 'Habillage'], 'ws://127.0.0.1:4455')
      : make(['Talk'], 'ws://127.0.0.1:4456')
}

let hub: Hub
let origin: string
let dir: string
let room: RoomApp
let regie: string
/** Ce que le faux sélecteur de dossier rend, et le point de départ reçu. */
let dossierChoisi: string | null
let dossierDemandeAvec: string | null | undefined
/** Le dossier que la salle a en configuration, pour comparer. */
let recordingRootConfigure: string

beforeEach(async () => {
  dossierChoisi = null
  dossierDemandeAvec = undefined
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-regie-'))
  const recDir = join(dir, 'rec')
  recordingRootConfigure = recDir
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
    // Le sélecteur de dossier du poste. Fourni par Electron en vrai ; ici par
    // le test, qui décide ce que l'opérateur choisit — ou s'il renonce.
    choisirDossier: async (initial) => {
      dossierDemandeAvec = initial
      return dossierChoisi
    },
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
  it('sert une page qui ne sort pas de son origine', async () => {
    const html = await (await fetch(`${regie}/regie`)).text()

    /*
     * L'invariant d'autonomie, sous la forme qu'il a prise avec le bundle :
     * **aucune ressource hors de l'origine servie**. La formulation d'avant —
     * tout inliné, aucune balise `src` ni `href` — visait la même chose, mais
     * ce qu'elle protégeait était le réseau, pas la balise : un fichier servi
     * par le processus qui sert déjà la page ne peut pas disparaître à une
     * coupure. Ici, ce n'est pas un test de forme mais de dernier recours — la
     * machine de salle tourne parfois sans réseau du tout.
     */
    const ressources = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((trouve) => trouve[1]!)
    expect(ressources.length).toBeGreaterThan(0)
    for (const url of ressources) expect(url.startsWith('/')).toBe(true)

    // Le nom de l'événement est relu du cache à chaque requête, jamais figé
    // dans le binaire installé sur la machine de salle.
    expect(html).toMatch(/<title>Régie — .+<\/title>/)
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

  it('pose les repères de editing, et les tient à part des chapitres', async () => {
    await agir({ action: 'recording.start' })

    await agir({ action: 'recording.mark', label: 'Début', role: 'debut' })
    // Reposé aussitôt : c'est le geste du faux départ, et il ne doit rien
    // empiler. Ce que la régie lit, c'est un repère, pas deux.
    await agir({ action: 'recording.mark', label: 'Début', role: 'debut' })
    await agir({ action: 'recording.mark', label: 'Questions' })

    const vue = await etat()
    expect(vue.diagnostics?.recording.editing.startMs).not.toBeNull()
    expect(vue.diagnostics?.recording.editing.endMs).toBeNull()
    // Les deux repères ne se comptent pas parmi les chapitres : seul
    // « Questions » en est un.
    expect(vue.diagnostics?.recording.markers).toBe(1)

    await agir({ action: 'recording.stop' })
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
    expect(Array.isArray(diagnostics?.log)).toBe(true)
  }, 40_000)
})

describe('configuration de la salle depuis la régie', () => {
  it('propose les scènes réellement déclarées dans chaque instance', async () => {
    // Choisir un nom de scène dans une liste lue sur OBS plutôt que le retaper :
    // c'est la faute de frappe qui produit un rôle introuvable.
    const diagnostics = (await etat()).diagnostics
    expect(diagnostics?.obs.A?.scenes).toEqual(['Capture HDMI', 'Habillage'])
    expect(diagnostics?.obs.B?.scenes).toEqual(['Talk'])

    expect((await agir({ action: 'obs.refreshScenes' })).body.ok).toBe(true)
  }, 40_000)

  /** Rôles inversés : la bascule doit suivre la configuration, pas l'inverse. */
  const INVERSER_LES_ROLES = {
    action: 'room.configure',
    patch: {
      obs: { A: { url: 'ws://127.0.0.1:4455' }, B: { url: 'ws://127.0.0.1:4456' } },
      sceneRoles: { A: { LIVE: 'Habillage', HOLD: 'Capture HDMI' }, B: { TALK: 'Talk' } },
      fileSlug: 'salle1',
    },
  }

  it('enregistre sur le hub sans rien couper', async () => {
    // Appliquer voudrait dire reconnecter, donc couper — y compris une
    // captation en cours. Le moment appartient à l'opérateur.
    expect((await agir(INVERSER_LES_ROLES)).body.ok).toBe(true)

    expect(hub.services.rooms.get(TRACK_1)!.fileSlug).toBe('salle1')
    const diagnostics = (await etat()).diagnostics
    expect(diagnostics?.config?.fileSlug).toBe('salle1')
    // La connexion tient, sur les réglages d'avant — et la régie le dit.
    expect(diagnostics?.obs.A?.connected).toBe(true)
    expect(diagnostics?.config?.obs.A.pending).toBe(true)

    await agir({ action: 'scene.set', role: 'HOLD' })
    expect((await etat()).diagnostics?.obs.A?.currentSceneName).toBe('Habillage')
  }, 40_000)

  it('applique les réglages à l\'instance qu\'on connecte', async () => {
    await agir(INVERSER_LES_ROLES)

    expect((await agir({ action: 'obs.connect', instance: 'A' })).body.ok).toBe(true)

    const diagnostics = (await etat()).diagnostics
    expect(diagnostics?.obs.A?.connected).toBe(true)
    expect(diagnostics?.config?.obs.A.pending).toBe(false)

    // « HOLD » désigne désormais l'autre scène : c'est bien la nouvelle
    // configuration qui pilote.
    await agir({ action: 'scene.set', role: 'HOLD' })
    expect((await etat()).diagnostics?.obs.A?.currentSceneName).toBe('Capture HDMI')
  }, 40_000)

  it('ne touche pas à la captation quand on reconnecte la projection', async () => {
    // Le défaut qu'on évite : reconnecter les deux instances d'un bloc pour
    // appliquer un réglage de projection, et perdre la prise en cours.
    await agir({ action: 'recording.start' })
    expect((await etat()).diagnostics?.obs.B?.recording).toBe(true)

    await agir(INVERSER_LES_ROLES)
    await agir({ action: 'obs.connect', instance: 'A' })

    const diagnostics = (await etat()).diagnostics
    // OBS-B n'a pas été rouvert : son enregistrement est toujours là.
    expect(diagnostics?.obs.B?.recording).toBe(true)
    expect(diagnostics?.recording.active).toBe(true)
    // Et ses réglages, eux, restent en attente d'une reconnexion.
    expect(diagnostics?.config?.obs.B.pending).toBe(false)
  }, 40_000)

  it('rend l\'échec de connexion à l\'opérateur, sans le faire attendre', async () => {
    // Une seule tentative quand c'est demandé à la main : la boucle de reprise
    // repart en fond, mais le retour est immédiat et lisible.
    await agir({
      action: 'room.configure',
      patch: { obs: { A: { url: 'ws://127.0.0.1:1' }, B: { url: 'ws://127.0.0.1:4456' } } },
    })

    const resultat = await agir({ action: 'obs.connect', instance: 'A' })
    expect(resultat.status).toBe(409)
    expect(resultat.body.message).toContain('OBS-A')
  }, 40_000)

  it('ne redescend jamais les mots de passe OBS jusqu\'à la page', async () => {
    await agir({
      action: 'room.configure',
      patch: {
        obs: {
          A: { url: 'ws://127.0.0.1:4455', password: 'mot-de-passe-tres-secret' },
          B: { url: 'ws://127.0.0.1:4456' },
        },
      },
    })

    const diagnostics = (await etat()).diagnostics
    expect(diagnostics?.config?.obs.A).toEqual({
      url: 'ws://127.0.0.1:4455',
      hasPassword: true,
      pending: true,
    })
    // La charge utile entière : le secret ne doit apparaître nulle part.
    expect(JSON.stringify(diagnostics)).not.toContain('mot-de-passe-tres-secret')
  }, 40_000)

  it('refuse un correctif mal formé avant qu\'il n\'atteigne le hub', async () => {
    expect((await agir({ action: 'room.configure', patch: { displayPort: -1 } })).status).toBe(400)
    expect(hub.services.rooms.get(TRACK_1)!.displayPort).toBe(7788)
  }, 40_000)
})

/**
 * Contrôle des rushes depuis la régie.
 *
 * De bout en bout : ce qui est écrit sur le disque par la captation doit se
 * retrouver dans la liste, et le verdict posé doit survivre à la fermeture de
 * la modale. C'est le seul moment où l'on peut encore refaire une prise — le
 * soir, la salle est démontée.
 */
/**
 * Le dossier des VOD, choisi sur le poste.
 *
 * Un chemin de disque se saisit à la main sans erreur seulement quand on l'a
 * sous les yeux — et c'est le disque de **la machine de salle** qu'il désigne,
 * où qu'on lise la page.
 */
describe('sélecteur de dossier', () => {
  it('rend le chemin choisi, et part du dossier déjà saisi', async () => {
    dossierChoisi = '/media/rushes/2026'
    const resultat = await agir({ action: 'config.chooseFolder' })

    expect(resultat.body.ok).toBe(true)
    expect((resultat.body as { detail?: unknown }).detail).toBe('/media/rushes/2026')
    // Corriger un chemin, c'est presque toujours en changer une branche : le
    // sélecteur s'ouvre là où l'on regardait, pas à la racine.
    expect(dossierDemandeAvec).toBe(recordingRootConfigure)
  })

  it('ne traite pas un renoncement comme un échec', async () => {
    dossierChoisi = null
    const resultat = await agir({ action: 'config.chooseFolder' })

    // Fermer un sélecteur est un geste, pas une panne : un rouge à ce
    // moment-là se lirait comme un refus du poste.
    expect(resultat.body.ok).toBe(true)
    expect((resultat.body as { detail?: unknown }).detail).toBeNull()
  })

  it('n’écrit rien dans la configuration de la salle', async () => {
    dossierChoisi = '/media/rushes/2026'
    await agir({ action: 'config.chooseFolder' })

    // C'est « Enregistrer » qui décide, comme pour tout le reste du panneau.
    expect(room.diagnostics().config?.recordingRoot).toBe(recordingRootConfigure)
  })

  it('annonce à la régie que ce poste sait l’ouvrir', () => {
    // La page ne peut pas le deviner : elle tourne aussi bien dans la fenêtre
    // Electron du poste que dans un navigateur ouvert à côté.
    expect(room.diagnostics().config?.canBrowse).toBe(true)
  })
})

describe('contrôle des enregistrements', () => {
  const lister = async () =>
    (await (await fetch(`${regie}/control/recordings`)).json()) as {
      ok: boolean
      root: string | null
      entries: {
        file: string
        sizeBytes: number
        sidecar: { title: string } | null
        check: { status: string; by: string; reasons: string[] } | null
      }[]
    }

  it('liste le rush produit, avec le titre de la conférence', async () => {
    expect((await lister()).entries).toEqual([])

    await agir({ action: 'recording.start' })
    await agir({ action: 'recording.stop' })

    const liste = await lister()
    expect(liste.root).toMatch(/rec$/)
    expect(liste.entries).toHaveLength(1)
    expect(liste.entries[0]!.file).toMatch(/\.mkv$/)
    // Le sidecar est apparié au fichier : c'est lui qui porte le titre.
    expect(liste.entries[0]!.sidecar?.title).toBeTruthy()
    expect(liste.entries[0]!.check).toBeNull()
  }, 40_000)

  it('refuse de déclarer exploitable un fichier de quatre octets', async () => {
    await agir({ action: 'recording.start' })
    await agir({ action: 'recording.stop' })
    const rush = (await lister()).entries[0]!

    const controle = await agir({ action: 'vod.inspect', file: rush.file })
    expect(controle.body.ok).toBe(true)

    const apres = (await lister()).entries[0]!
    // Le faux OBS écrit quatre octets : que ffprobe soit installé ou non sur la
    // machine de test, rien là-dedans ne peut passer pour une conférence.
    expect(apres.check?.status).not.toBe('ok')
    expect(apres.check?.reasons.length).toBeGreaterThan(0)
  }, 40_000)

  it('retient le verdict de l\'opérateur, et le laisse se reprendre', async () => {
    await agir({ action: 'recording.start' })
    await agir({ action: 'recording.stop' })
    const rush = (await lister()).entries[0]!

    await agir({ action: 'vod.verdict', file: rush.file, status: 'illisible' })
    expect((await lister()).entries[0]!.check).toMatchObject({ status: 'illisible', by: 'operateur' })

    await agir({ action: 'vod.verdict', file: rush.file, status: null })
    expect((await lister()).entries[0]!.check).toBeNull()
  }, 40_000)

  it('sert le rush tel quel, et par tranche', async () => {
    await agir({ action: 'recording.start' })
    await agir({ action: 'recording.stop' })
    const rush = (await lister()).entries[0]!
    const adresse = `${regie}/control/recordings/fichier?file=` + encodeURIComponent(rush.file)

    const entier = await fetch(adresse)
    expect(entier.status).toBe(200)
    expect(entier.headers.get('content-type')).toBe('video/x-matroska')
    expect(entier.headers.get('accept-ranges')).toBe('bytes')
    expect((await entier.text()).length).toBe(rush.sizeBytes)

    // Les tranches sont ce qui rend un fichier de trois gigaoctets navigable :
    // sans elles, un lecteur télécharge tout avant la première image.
    const tranche = await fetch(adresse, { headers: { range: 'bytes=1-2' } })
    expect(tranche.status).toBe(206)
    expect(tranche.headers.get('content-range')).toBe(`bytes 1-2/${rush.sizeBytes}`)
    expect((await tranche.text()).length).toBe(2)
  }, 40_000)

  it('ne laisse pas lire n\'importe quoi sur le disque', async () => {
    // La régie est servie en HTTP sur la machine : ces deux routes rendent des
    // octets, elles sont exactement l'endroit où un `..` coûterait cher.
    const lecture = await fetch(`${regie}/control/recordings/fichier?file=../../etc/passwd`)
    expect(lecture.status).toBe(409)

    const apercu = await fetch(`${regie}/control/recordings/extrait?file=../../etc/passwd`)
    expect(apercu.status).toBe(409)
  }, 40_000)

  it('rend 404 sur un rush qui n\'existe plus', async () => {
    const reponse = await fetch(`${regie}/control/recordings/fichier?file=jamais.mkv`)
    expect(reponse.status).toBe(404)
  }, 40_000)

  it('ne sort pas du dossier des enregistrements', async () => {
    // La page est servie en HTTP sur la machine : un `..` dans le nom du fichier
    // ferait lire, et marquer, n'importe quoi sur le disque.
    const resultat = await agir({ action: 'vod.inspect', file: '../../etc/passwd' })
    expect(resultat.status).toBe(409)
    expect(resultat.body.message).toContain('hors du dossier')
  }, 40_000)
})
