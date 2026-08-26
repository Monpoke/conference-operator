import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PAIRING_ALIAS, consoleViews, viewPath } from '@cloudnord/contract'
import { createHub, type Hub } from '../src/server.js'
import { renderAdminPage } from '../src/pages/admin-page.js'
import { renderWallPage } from '../src/pages/wall-page.js'
import { provisionOperator } from '../src/operators.js'

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'motdepasse-regie-2026' }
const TRACK_1 = 'track-1-teilhard-de-chardin'

let hub: Hub
let origin: string

beforeEach(async () => {
  hub = await createHub({
    port: 0,
    host: '127.0.0.1',
    databasePath: ':memory:',
    publicUrl: 'http://127.0.0.1',
    authSecret: 'test-secret-'.padEnd(48, 'x'),
    logLevel: 'fatal',
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
    sceneRoles: { A: {}, B: {} },
  })
})

afterEach(async () => {
  await hub.close()
})

/** Appel du contrat en HTTP nu, exactement comme le font les pages publiques. */
async function rpc(chemin: string, entree: unknown, jeton?: string) {
  const response = await fetch(`${origin}/rpc/${chemin}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(jeton != null ? { authorization: `Bearer ${jeton}` } : {}),
    },
    body: JSON.stringify({ json: entree }),
  })
  return { status: response.status, body: (await response.json()) as { json?: never } }
}

async function jetonOperateur(): Promise<string> {
  const response = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
  })
  return ((await response.json()) as { token: string }).token
}

describe('pages publiques', () => {
  it('sert un mur autonome, chargeable sur la 4G d\'une salle', async () => {
    const html = await (await fetch(`${origin}/mur?salle=${TRACK_1}`)).text()
    expect(html).toContain('Cloud Nord 2026')
    // Une dépendance externe rendrait la page inutilisable dès que le réseau
    // du lieu sature — précisément quand tout le monde la scanne.
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/)
    // La salle est injectée côté serveur : le QR porte le contexte.
    expect(html).toContain('Track #1 - Teilhard de Chardin')
  })

  it('sert la console d\'administration', async () => {
    const html = await (await fetch(`${origin}/admin`)).text()
    expect(html).toContain('console hub')
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/)
  })

  it('sert une adresse par onglet de la console', async () => {
    /**
     * Chaque onglet est une adresse : sans route côté hub, une console
     * rafraîchie sur `/admin/moderation` répondrait 404 — exactement là où
     * l'opérateur l'avait laissée ouverte.
     *
     * Les adresses sont énumérées depuis le contrat plutôt qu'écrites ici :
     * c'est la même liste que le hub emploie pour enregistrer ses routes et que
     * le routeur de la console emploie pour naviguer, donc une vue ajoutée sans
     * route se voit ici.
     *
     * Ce que sert chaque adresse dépend de l'avancement de la migration : le
     * gabarit pour les vues qui n'ont pas encore basculé, la coquille du bundle
     * pour celles qui l'ont fait. Le test accepte les deux **et rien d'autre** —
     * une page blanche à la place d'une console passerait autrement.
     */
    for (const chemin of [...consoleViews(false).map(viewPath), PAIRING_ALIAS]) {
      const reponse = await fetch(`${origin}${chemin}`)
      expect(reponse.status, chemin).toBe(200)
      const html = await reponse.text()
      expect(
        html.includes('console hub') || html.includes('id="console-boot"'),
        `${chemin} ne sert ni le gabarit ni la coquille`,
      ).toBe(true)
    }
  })

  it('sert le service worker à la racine', async () => {
    /**
     * La portée d'un service worker est celle de son chemin : servi sous
     * `/admin/`, il ne couvrirait pas le reste du hub — et sans lui, aucune
     * notification n'arrive console fermée.
     */
    const reponse = await fetch(`${origin}/sw.js`)
    expect(reponse.status).toBe(200)
    expect(reponse.headers.get('content-type')).toContain('javascript')
    // Revérifié à chaque chargement : le mettre en cache retarderait toute
    // correction d'un jour d'événement.
    expect(reponse.headers.get('cache-control')).toContain('no-cache')

    const code = await reponse.text()
    expect(code).toContain("addEventListener('push'")
    expect(() => new Function(code)).not.toThrow()
  })

  it("ne sert pas une vue qui n'existe pas", async () => {
    // Un joker servirait la console sur n'importe quelle faute de frappe, qui
    // s'ouvrirait alors sur l'exploitation sans dire que l'adresse est fausse.
    expect((await fetch(`${origin}/admin/moderationn`)).status).toBe(404)
    // `developpement` n'est rendue qu'en mode dev : le hub ne la sert pas non plus.
    expect((await fetch(`${origin}/admin/developpement`)).status).toBe(404)
  })

  it("sert l'adresse de vérification annoncée pendant l'appairage", async () => {
    /**
     * Cette adresse est affichée à l'écran de régie et suivie par un opérateur.
     * Elle était configurée dans Better Auth sans qu'aucune route ne la serve :
     * le lien renvoyait un 404, au moment précis où quelqu'un s'y fiait.
     */
    const reponse = await fetch(`${origin}/admin/devices?user_code=R6A67TTS`)
    expect(reponse.status).toBe(200)
    expect(await reponse.text()).toContain('console hub')
  })

  it("annonce une adresse de vérification que le hub sert réellement", async () => {
    // Vérifie l'accord entre ce que Better Auth promet et ce qui existe.
    const demande = await fetch(`${origin}/api/auth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: '01JB2ZK5T7QW9V0YHRXM3N4P6C' }),
    })
    const { verification_uri, verification_uri_complete } = (await demande.json()) as {
      verification_uri?: string
      verification_uri_complete?: string
    }
    const annoncee = verification_uri_complete ?? verification_uri
    expect(annoncee).toBeTruthy()

    // Rejouée sur ce hub-ci : l'URL annoncée porte l'origine de production.
    const chemin = new URL(annoncee!).pathname + new URL(annoncee!).search
    expect((await fetch(`${origin}${chemin}`)).status).toBe(200)
  })
})

describe('dépôt public et modération', () => {
  it('garde un message en attente puis le publie après relecture', async () => {
    const depot = await rpc('wall/post', { roomId: TRACK_1, author: 'Alice', text: 'Super talk !' })
    expect(depot.status).toBe(200)

    // Rien n'atteint l'écran sans décision humaine.
    expect(hub.services.wall.approved()).toEqual([])

    const jeton = await jetonOperateur()
    const attente = await rpc('wall/pending', {}, jeton)
    expect((attente.body.json as unknown as { id: string }[])).toHaveLength(1)

    const id = (attente.body.json as unknown as { id: string }[])[0]!.id
    expect((await rpc('wall/moderate', { id, decision: 'approve' }, jeton)).status).toBe(200)
    expect(hub.services.wall.approved().map((c) => c.text)).toEqual(['Super talk !'])
  })

  it('exige une session opérateur pour modérer', async () => {
    const depot = await rpc('wall/post', { roomId: null, author: 'A', text: 'coucou' })
    expect(depot.status).toBe(200)
    // Un participant ne doit pas pouvoir publier son propre message.
    expect((await rpc('wall/pending', {})).status).toBe(401)
    expect((await rpc('wall/moderate', { id: 'x', decision: 'approve' })).status).toBe(401)
  })

  it('freine un déposant trop rapide', async () => {
    const envoyer = () => rpc('wall/post', { roomId: null, author: 'A', text: 'spam' })

    const statuts: number[] = []
    for (let i = 0; i < 8; i += 1) statuts.push((await envoyer()).status)

    // Cinq d'affilée passent — un participant enthousiaste — puis ça freine.
    expect(statuts.filter((s) => s === 200)).toHaveLength(5)
    expect(statuts.filter((s) => s === 429).length).toBeGreaterThan(0)
  })

  it('accepte questions et votes sans compte', async () => {
    const posee = await rpc('questions/post', {
      roomId: TRACK_1,
      sessionId: null,
      author: 'Alice',
      text: 'Comment gérez-vous la reprise ?',
    })
    const question = posee.body.json as unknown as { id: string }

    const vote = await rpc('questions/vote', { id: question.id, deviceId: 'appareil-mobile-1' })
    expect((vote.body.json as unknown as { votes: number }).votes).toBe(1)

    // Un second vote du même appareil est sans effet, pas une erreur.
    const encore = await rpc('questions/vote', { id: question.id, deviceId: 'appareil-mobile-1' })
    expect((encore.body.json as unknown as { votes: number }).votes).toBe(1)

    const liste = await rpc('questions/list', { roomId: TRACK_1, sessionId: null })
    expect((liste.body.json as unknown as unknown[])).toHaveLength(1)
  })

  /**
   * Ce qui est déjà à l'écran, relu depuis le mobile.
   *
   * Ces messages sont publics au sens le plus fort : ils sont projetés en
   * grand dans les salles. Les redonner au téléphone qui vient d'en déposer un
   * est ce qui fait la différence entre un formulaire de contact et un mur.
   */
  it('rend les messages déjà projetés, sans compte', async () => {
    const depose = await rpc('wall/post', {
      roomId: null,
      author: 'Camille',
      text: 'Super talk, merci !',
    })
    const { id } = depose.body.json as unknown as { id: string }

    // Rien avant modération : le mur ne montre que ce qui est passé par une
    // décision humaine.
    const avant = await rpc('wall/recent', { limit: 12 })
    expect(avant.body.json as unknown as unknown[]).toHaveLength(0)

    const jeton = await jetonOperateur()
    await rpc('wall/moderate', { id, decision: 'approve' }, jeton)

    const apres = await rpc('wall/recent', { limit: 12 })
    const messages = apres.body.json as unknown as { text: string }[]
    expect(messages.map((message) => message.text)).toEqual(['Super talk, merci !'])
  })
})

describe('cycle de vie des conférences depuis la console', () => {
  it('démarre, termine et remet à venir', async () => {
    const jeton = await jetonOperateur()
    const session = hub.services.programs.active()!.program.sessions.find(
      (s) => s.roomId === TRACK_1 && s.kind === 'talk',
    )!

    const demarre = await rpc('sessions/start', { sessionId: session.id }, jeton)
    expect((demarre.body.json as unknown as { status: string }).status).toBe('running')

    const termine = await rpc('sessions/end', { sessionId: session.id }, jeton)
    expect((termine.body.json as unknown as { status: string }).status).toBe('ended')

    await rpc('sessions/reset', { sessionId: session.id }, jeton)
    const etats = await rpc('sessions/states', { roomId: TRACK_1 }, jeton)
    expect(etats.body.json as unknown as unknown[]).toEqual([])
  })

  it('refuse une session absente du programme', async () => {
    const jeton = await jetonOperateur()
    // Écrire un état orphelin donnerait l'illusion d'avoir agi.
    const resultat = await rpc('sessions/start', { sessionId: 'inexistante' }, jeton)
    expect(resultat.status).toBe(404)
  })

  it('réserve le pilotage aux opérateurs', async () => {
    const session = hub.services.programs.active()!.program.sessions[0]!
    expect((await rpc('sessions/start', { sessionId: session.id })).status).toBe(401)
    expect((await rpc('settings/update', { autoEndGraceMinutes: 1 })).status).toBe(401)
  })

  it('lit et modifie le délai de clôture automatique', async () => {
    const jeton = await jetonOperateur()
    expect(await rpc('settings/get', {}, jeton).then((r) => r.body.json)).toMatchObject({
      autoEndEnabled: true,
      autoEndGraceMinutes: 5,
    })

    const modifie = await rpc('settings/update', { autoEndGraceMinutes: 12 }, jeton)
    expect(modifie.body.json as unknown as { autoEndGraceMinutes: number }).toMatchObject({
      autoEndGraceMinutes: 12,
    })
    expect(hub.services.settings.get().autoEndGraceMinutes).toBe(12)
  })

  it('sert la page de réglages dans la console', async () => {
    const html = await (await fetch(`${origin}/admin`)).text()
    expect(html).toContain('Clôture automatique')
    expect(html).toContain('Délai de grâce')
  })
})

describe('JavaScript embarqué des pages du hub', () => {
  /**
   * Ces pages n'ont pas d'étape de build : leur script vit dans un template
   * literal, où TypeScript ne voit qu'une chaîne. Une erreur y casse toute la
   * page — cas déjà rencontré côté régie, avec une apostrophe dont l'antislash
   * s'effondrait dans le template.
   */
  const pages: [string, string][] = [
    ['console', renderAdminPage()],
    ['mur', renderWallPage({ roomId: 'r', rooms: [{ id: 'r', name: 'R' }] })],
  ]

  it.each(pages)('%s : analysable', (_nom, html) => {
    const scripts = [...html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)]
      .map((correspondance) => correspondance[1] ?? '')
      .filter((code) => code.trim().length > 0)

    expect(scripts.length).toBeGreaterThan(0)
    for (const code of scripts) expect(() => new Function(code)).not.toThrow()
  })
})

describe("heure simulée du hub", () => {
  it("propage l'heure et le signale", async () => {
    const simule = await createHub({
      port: 0,
      host: '127.0.0.1',
      databasePath: ':memory:',
      publicUrl: 'http://127.0.0.1',
      authSecret: 'test-secret-'.padEnd(48, 'x'),
      logLevel: 'fatal',
      // L'heure simulée ne s'applique qu'en mode développement — c'est ce que
      // vérifie `mode.test.ts`, et ce que ce hub-là doit donc déclarer.
      mode: 'dev',
      simulatedTime: '2026-10-30T10:20:00.000Z',
    })
    await simule.app.listen({ port: 0, host: '127.0.0.1' })
    const adresse = simule.app.server.address()
    const base = `http://127.0.0.1:${typeof adresse === 'object' && adresse != null ? adresse.port : 0}`

    const reponse = await fetch(`${base}/rpc/meta/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { protocolVersion: 1 } }),
    })
    const corps = (await reponse.json()) as { json: { serverTime: string; simulatedClock: boolean } }

    // Les salles calent leur horloge sur cette valeur : la simuler ici déplace
    // tout le système, sans rien à régler de leur côté.
    expect(corps.json.serverTime.startsWith('2026-10-30T10:2')).toBe(true)
    expect(corps.json.simulatedClock).toBe(true)

    await simule.close()
  })

  it("date les commandes avec l'heure simulée", async () => {
    const simule = await createHub({
      port: 0,
      host: '127.0.0.1',
      databasePath: ':memory:',
      publicUrl: 'http://127.0.0.1',
      authSecret: 'test-secret-'.padEnd(48, 'x'),
      logLevel: 'fatal',
      // L'heure simulée ne s'applique qu'en mode développement — c'est ce que
      // vérifie `mode.test.ts`, et ce que ce hub-là doit donc déclarer.
      mode: 'dev',
      simulatedTime: '2026-10-30T10:20:00.000Z',
    })
    simule.services.rooms.upsert({
      id: TRACK_1,
      name: 'Track #1',
      trackId: TRACK_1,
      obs: {
        A: { url: 'ws://127.0.0.1:4455', password: null },
        B: { url: 'ws://127.0.0.1:4456', password: null },
      },
      sceneRoles: { A: {}, B: {} },
    })

    const commande = simule.services.commands.publish(
      TRACK_1,
      { type: 'message.broadcast', text: 'Pause déjeuner', level: 'info' },
      600,
    )

    /**
     * C'est le point qui comptait : avec une horloge réelle côté hub et une
     * salle simulée en octobre, le filtre d'obsolescence écartait toute
     * commande à TTL. Les deux horloges doivent venir du même endroit.
     */
    expect(commande.issuedAt.startsWith('2026-10-30')).toBe(true)
    await simule.close()
  })

  it("reste sur l'heure réelle sans configuration", async () => {
    const reponse = await fetch(`${origin}/rpc/meta/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { protocolVersion: 1 } }),
    })
    const corps = (await reponse.json()) as { json: { simulatedClock: boolean } }
    expect(corps.json.simulatedClock).toBe(false)
  })
})

describe("réglage de l'heure depuis la console", () => {
  /** Le mode fait foi : il n'y a plus d'interrupteur séparé pour l'horloge. */
  const creerHub = (mode: 'production' | 'dev' = 'production') =>
    createHub({
      port: 0,
      host: '127.0.0.1',
      databasePath: ':memory:',
      publicUrl: 'http://127.0.0.1',
      authSecret: 'test-secret-'.padEnd(48, 'x'),
      logLevel: 'fatal',
      mode,
    })

  async function adresseEtJeton(h: Hub) {
    await h.app.listen({ port: 0, host: '127.0.0.1' })
    const a = h.app.server.address()
    const base = `http://127.0.0.1:${typeof a === 'object' && a != null ? a.port : 0}`
    await provisionOperator(h.auth, OPERATOR)
    const r = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
    })
    return { base, jeton: ((await r.json()) as { token: string }).token }
  }

  const appeler = (base: string, chemin: string, entree: unknown, jeton: string) =>
    fetch(`${base}/rpc/${chemin}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jeton}` },
      body: JSON.stringify({ json: entree }),
    })

  it('refuse sur un hub de production, en expliquant comment ouvrir', async () => {
    const h = await creerHub()
    const { base, jeton } = await adresseEtJeton(h)

    const reponse = await appeler(base, 'clock/set', { at: '2026-10-30T10:20:00.000Z' }, jeton)
    expect(reponse.status).toBe(403)
    const corps = (await reponse.json()) as { json: { message: string } }
    // Changer l'heure pendant l'événement fausserait les timecodes : fermé par
    // défaut, et le message dit comment l'ouvrir en connaissance de cause.
    expect(corps.json.message).toContain('MODE=dev')

    const etat = await appeler(base, 'clock/get', {}, jeton)
    expect(((await etat.json()) as { json: { controllable: boolean } }).json.controllable).toBe(false)

    await h.close()
  })

  it("déplace l'heure quand le réglage est ouvert", async () => {
    const h = await creerHub('dev')
    const { base, jeton } = await adresseEtJeton(h)

    const reponse = await appeler(base, 'clock/set', { at: '2026-10-30T10:20:00.000Z' }, jeton)
    expect(reponse.status).toBe(200)
    const corps = (await reponse.json()) as { json: { serverTime: string; simulated: boolean } }
    expect(corps.json.serverTime.startsWith('2026-10-30T10:2')).toBe(true)
    expect(corps.json.simulated).toBe(true)

    // Tout ce qui est daté par le hub suit, y compris les commandes.
    h.services.rooms.upsert({
      id: TRACK_1,
      name: 'Track #1',
      trackId: TRACK_1,
      obs: {
        A: { url: 'ws://127.0.0.1:4455', password: null },
        B: { url: 'ws://127.0.0.1:4456', password: null },
      },
      sceneRoles: { A: {}, B: {} },
    })
    const commande = h.services.commands.publish(TRACK_1, { type: 'scene.force', role: 'HOLD' }, null)
    expect(commande.issuedAt.startsWith('2026-10-30')).toBe(true)

    await h.close()
  })

  it('diffuse le réalignement aux salles', async () => {
    const h = await creerHub('dev')
    const { base, jeton } = await adresseEtJeton(h)

    await appeler(base, 'clock/set', { at: '2026-10-30T10:20:00.000Z' }, jeton)

    // Sans cette diffusion, les écrans afficheraient un autre moment que la
    // console jusqu'à leur prochaine synchronisation.
    const diffusees = h.services.commands.backlog(TRACK_1, 0)
    const realignement = diffusees.find((c) => c.payload.type === 'clock.changed')
    expect(realignement?.payload).toMatchObject({ simulated: true })

    await h.close()
  })

  it('revient à l\'heure réelle', async () => {
    const h = await creerHub('dev')
    const { base, jeton } = await adresseEtJeton(h)

    await appeler(base, 'clock/set', { at: '2026-10-30T10:20:00.000Z' }, jeton)
    const retour = await appeler(base, 'clock/set', { at: null }, jeton)
    const corps = (await retour.json()) as { json: { simulated: boolean } }

    expect(corps.json.simulated).toBe(false)
    await h.close()
  })

  it("réserve le réglage aux opérateurs", async () => {
    const h = await creerHub('dev')
    await h.app.listen({ port: 0, host: '127.0.0.1' })
    const a = h.app.server.address()
    const base = `http://127.0.0.1:${typeof a === 'object' && a != null ? a.port : 0}`

    const anonyme = await fetch(`${base}/rpc/clock/set`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { at: null } }),
    })
    expect(anonyme.status).toBe(401)
    await h.close()
  })
})

/**
 * Bandeau live.
 *
 * L'historique est lu dans les commandes émises : elles sont déjà persistées,
 * datées et ordonnées, et une seconde copie ne pourrait que diverger de ce qui
 * est réellement parti dans les salles.
 */
describe('bandeau live', () => {
  const creerHub = () =>
    createHub({
      port: 0,
      host: '127.0.0.1',
      databasePath: ':memory:',
      publicUrl: 'http://127.0.0.1',
      authSecret: 'test-secret-'.padEnd(48, 'x'),
      logLevel: 'fatal',
    })

  async function console_(h: Hub) {
    await h.app.listen({ port: 0, host: '127.0.0.1' })
    const a = h.app.server.address()
    const base = `http://127.0.0.1:${typeof a === 'object' && a != null ? a.port : 0}`
    await provisionOperator(h.auth, OPERATOR)
    const r = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
    })
    const jeton = ((await r.json()) as { token: string }).token
    return async (chemin: string, entree: unknown) => {
      const reponse = await fetch(`${base}/rpc/${chemin}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${jeton}` },
        body: JSON.stringify({ json: entree }),
      })
      return { status: reponse.status, body: (await reponse.json()) as { json?: never } }
    }
  }

  it('retient ce qui est passé, et dit lequel est affiché', async () => {
    const h = await creerHub()
    const appeler = await console_(h)

    await appeler('overlay/show', { roomId: null, message: { text: 'Premier', level: 'info' } })
    await appeler('overlay/show', { roomId: null, message: { text: 'Second', level: 'warning' } })

    const passes = (await appeler('overlay/history', {})).body.json as unknown as {
      message: { text: string }
      visible: boolean
    }[]

    // Du plus récent au plus ancien : c'est celui qu'on veut remettre en premier.
    expect(passes.map((p) => p.message.text)).toEqual(['Second', 'Premier'])
    expect(passes.map((p) => p.visible)).toEqual([true, false])

    await h.close()
  })

  it('n\'affiche plus rien après un retrait', async () => {
    const h = await creerHub()
    const appeler = await console_(h)

    await appeler('overlay/show', { roomId: null, message: { text: 'Premier', level: 'info' } })
    await appeler('overlay/hide', { roomId: null })

    const passes = (await appeler('overlay/history', {})).body.json as unknown as {
      message: { text: string }
      visible: boolean
    }[]

    // Le retrait n'est pas de l'historique — on ne remet pas « rien » à
    // l'antenne — mais il éteint le bandeau qu'il a retiré.
    expect(passes.map((p) => p.message.text)).toEqual(['Premier'])
    expect(passes.every((p) => !p.visible)).toBe(true)

    await h.close()
  })
})

/**
 * Conférence en cours, vue du mur public.
 *
 * Publique comme le mur lui-même : ces titres sont déjà projetés sur l'écran
 * de la salle, et sans eux « posez votre question » ne dit pas à propos de quoi.
 */
describe('conférence en cours, côté public', () => {
  it('la donne sans authentification', async () => {
    const h = await createHub({
      port: 0,
      host: '127.0.0.1',
      databasePath: ':memory:',
      publicUrl: 'http://127.0.0.1',
      authSecret: 'test-secret-'.padEnd(48, 'x'),
      logLevel: 'fatal',
      mode: 'dev',
      simulatedTime: '2026-10-30T10:20:00.000Z',
    })
    await h.app.listen({ port: 0, host: '127.0.0.1' })
    const adresse = h.app.server.address()
    const base = `http://127.0.0.1:${typeof adresse === 'object' && adresse != null ? adresse.port : 0}`
    const snapshot = h.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
    h.services.rooms.ensureFromTracks(snapshot.program.rooms)

    const reponse = await fetch(`${base}/rpc/rooms/current`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { roomId: TRACK_1 } }),
    })

    expect(reponse.status).toBe(200)
    const corps = (await reponse.json()) as {
      json: { current: { title: string; speakers: string[] } | null; next: { title: string } | null }
    }
    expect(corps.json.current?.title).toContain('HoneySwamp')
    expect(corps.json.current?.speakers.length).toBeGreaterThan(0)
    expect(corps.json.next?.title).toBeTruthy()

    await h.close()
  })
})
