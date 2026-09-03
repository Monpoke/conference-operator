import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeProgram, type Program } from '@cloudnord/program'
import { AssetCache } from '../src/core/assets.js'
import { DisplayServer, type DisplayPayload } from '../src/core/display-server.js'
import { LocalStore } from '../src/core/store.js'
import { RoomRuntime } from '../src/core/runtime.js'

const program = normalizeProgram(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
      'utf8',
    ),
  ),
)

const TRACK_1 = 'track-1-teilhard-de-chardin'

let dir: string
let store: LocalStore
let assets: AssetCache
let runtime: RoomRuntime
let server: DisplayServer
let origin: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-display-'))
  store = new LocalStore(':memory:')
  assets = new AssetCache(store, join(dir, 'assets'))
  store.saveProgram('hash-1', program)

  runtime = new RoomRuntime(store, {}, () => Date.parse('2026-10-30T10:20:00.000Z'))
  runtime.setRoomId(TRACK_1)
  runtime.setProgram('hash-1', program)

  server = new DisplayServer({
    runtime,
    assets,
    program: () => store.activeProgram(),
    roomName: () => 'Track #1 — Teilhard de Chardin',
    port: 0,
  })
  origin = await server.listen()
})

afterEach(async () => {
  await server.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Lit les N premiers messages d'un flux SSE puis referme. */
/**
 * Lit le flux comme le ferait une page : un instantané complet à l'ouverture,
 * puis des deltas fusionnés par-dessus. Renvoie l'état reconstitué après chaque
 * message, et le message brut, pour pouvoir vérifier ce qui a réellement circulé.
 */
async function readSse(
  url: string,
  count: number,
  trigger?: () => void,
): Promise<{ merged: DisplayPayload; raw: Record<string, unknown>; delta: boolean }[]> {
  const controller = new AbortController()
  const response = await fetch(url, { signal: controller.signal })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const messages: { merged: DisplayPayload; raw: Record<string, unknown>; delta: boolean }[] = []
  let courant: Record<string, unknown> = {}
  let buffer = ''
  let triggered = false

  while (messages.length < count) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let index: number
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const lignes = block.split('\n')
      const data = lignes.find((ligne) => ligne.startsWith('data: '))
      if (data == null) continue
      const delta = lignes.some((ligne) => ligne === 'event: delta')
      const raw = JSON.parse(data.slice(6)) as Record<string, unknown>
      courant = delta ? { ...courant, ...raw } : raw
      messages.push({ merged: courant as unknown as DisplayPayload, raw, delta })
    }
    if (!triggered && trigger != null) {
      triggered = true
      trigger()
    }
  }
  controller.abort()
  return messages
}

/** Compte les messages reçus pendant une fenêtre de temps donnée. */
async function compterSse(url: string, durationMs: number): Promise<number> {
  const controller = new AbortController()
  const response = await fetch(url, { signal: controller.signal })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let recus = 0
  let buffer = ''
  const fin = Date.now() + durationMs
  const arret = setTimeout(() => controller.abort(), durationMs)
  try {
    while (Date.now() < fin) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        if (block.includes('data: ')) recus += 1
      }
    }
  } catch {
    // L'abandon du flux est la façon normale de terminer cette lecture.
  }
  clearTimeout(arret)
  controller.abort()
  return recus
}

describe('serveur d\'affichage local', () => {
  it('sert une page autonome, à un script facultatif près', async () => {
    const html = await (await fetch(`${origin}/display/projector`)).text()
    expect(html).toContain('<!doctype html>')
    /*
     * Une balise vers un CDN casserait l'écran dès la première coupure réseau.
     * Seul le bouton de X y échappe : chargé en `async`, en dernier, et rien
     * de ce qui se lit n'en dépend — la slide Réseaux porte le hashtag en
     * grand, qui reste là sans lui.
     */
    const externes = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)]
      .map((trouve) => trouve[1]!)
      .filter((adresse) => /^(?:https?:)?\/\//.test(adresse))
    expect(externes).toEqual(['https://platform.x.com/widgets.js'])
    expect(html).toContain("new EventSource('/display/state?vue=projecteur')")
  })

  it('expose le programme filtré sur la salle', async () => {
    const payload = (await (await fetch(`${origin}/display/data`)).json()) as DisplayPayload
    // 15 des 27 sessions de l'événement se tiennent dans cette salle.
    expect(payload.sessions).toHaveLength(15)
    expect(payload.sessions.every((session) => session.roomId === TRACK_1)).toBe(true)
    expect(payload.sponsorTiers[0]?.name).toBe('Gold')
    expect(payload.state.currentSession?.title).toContain('HoneySwamp')
    // Le nom lisible, pas l'identifiant technique : c'est projeté en salle.
    expect(payload.roomName).toBe('Track #1 — Teilhard de Chardin')
  })

  it('pousse le premier état immédiatement, puis chaque changement', async () => {
    const messages = await readSse(`${origin}/display/state?vue=projecteur`, 2, () => {
      void runtime.setDisplayMode('programme')
    })

    // L'écran ne doit jamais attendre un changement pour afficher quelque chose.
    expect(messages[0]?.merged.state.mode).toBe('loop')
    expect(messages[1]?.merged.state.mode).toBe('programme')
    // Le premier message est complet, le suivant ne porte que ce qui a bougé.
    expect(messages[0]?.delta).toBe(false)
    expect(messages[1]?.delta).toBe(true)
    expect(Object.keys(messages[1]!.raw)).toEqual(['state'])
  })

  it("n'envoie rien quand le tic d'horloge ne change rien", async () => {
    // Le tic recalcule la timeline toutes les 5 s. Sans changement réel, il ne
    // doit produire aucun trafic : c'est ce qui faisait republier 43 Ko à vide.
    const flux = compterSse(`${origin}/display/state?vue=projecteur`, 1_500)
    for (let i = 0; i < 20; i++) runtime.refreshSessions()
    // Seul l'instantané d'ouverture doit avoir circulé.
    expect(await flux).toBe(1)
  })

  it("n'envoie à l'overlay que les champs qu'il lit", async () => {
    const messages = await readSse(`${origin}/display/state?vue=overlay`, 2, () => {
      void runtime.setDisplayMode('live')
    })
    // Le programme de la salle pèse l'essentiel de la charge utile, et
    // l'overlay ne l'affiche jamais.
    expect(Object.keys(messages[0]!.raw).sort()).toEqual(['event', 'eventIdentity', 'state'])
    expect(messages[0]!.raw).not.toHaveProperty('sessions')
    expect(messages[0]!.raw).not.toHaveProperty('diagnostics')
  })

  it('sert la charge utile complète à qui ne précise pas de vue', async () => {
    // `/display/data` et les tools de diagnostic n'ont pas à connaître les vues.
    const messages = await readSse(`${origin}/display/state`, 1)
    expect(Object.keys(messages[0]!.raw)).toContain('sessions')
    expect(Object.keys(messages[0]!.raw)).toContain('diagnostics')
  })

  it('sert les assets depuis le cache local', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('PNG-OCTETS', { status: 200, headers: { 'content-type': 'image/png' } }),
    ) as unknown as typeof fetch
    const ref = await assets.fetchOne('https://cdn.exemple/logo.png', fetchImpl)

    const response = await fetch(`${origin}${ref.localUrl}`)
    expect(await response.text()).toBe('PNG-OCTETS')
    expect(response.headers.get('content-type')).toBe('image/png')
    // Adressé par contenu : cacheable indéfiniment par la Browser Source d'OBS.
    expect(response.headers.get('cache-control')).toContain('immutable')
  })

  it('répond 404 sur un asset absent plutôt que de bloquer le rendu', async () => {
    expect((await fetch(`${origin}/assets/${'0'.repeat(64)}`)).status).toBe(404)
  })

  it('reste servable sans programme en cache', async () => {
    const vide = new LocalStore(':memory:')
    const autre = new DisplayServer({
      runtime: new RoomRuntime(vide),
      assets: new AssetCache(vide, join(dir, 'vide')),
      program: () => null,
      port: 0,
    })
    const autreOrigin = await autre.listen()

    // Première mise en service, avant tout sync : la page doit s'afficher
    // malgré tout plutôt que de laisser un écran noir en salle.
    const payload = (await (await fetch(`${autreOrigin}/display/data`)).json()) as DisplayPayload
    expect(payload.sessions).toEqual([])
    expect(payload.state.mode).toBe('loop')
    expect((await fetch(`${autreOrigin}/display/projector`)).status).toBe(200)

    await autre.close()
    vide.close()
  })
})

describe('vumètre', () => {
  it("n'abonne la salle que pendant qu'une régie regarde", async () => {
    // La propriété qui justifie un flux séparé : OBS émet 50 fois par seconde,
    // sur la machine qui encode. Personne ne regarde, personne ne paie.
    const demandes: boolean[] = []
    const local = new DisplayServer({
      runtime,
      assets,
      program: () => store.activeProgram(),
      onLevelsRequested: (actif) => demandes.push(actif),
      port: 0,
    })
    const url = await local.listen()

    try {
      expect(demandes).toEqual([])

      const controleur = new AbortController()
      const flux = await fetch(`${url}/display/audio`, { signal: controleur.signal })
      const lecteur = flux.body!.getReader()
      // L'abonnement est posé à l'ouverture du flux.
      await vi.waitFor(() => expect(demandes).toEqual([true]))

      local.publishLevels([{ name: 'Micro', channels: [{ magnitude: -18, peak: -16 }] }])

      // Le premier bloc est le commentaire d'ouverture, qui pousse les
      // en-têtes ; on lit jusqu'à la première mesure.
      const decodeur = new TextDecoder()
      let recu = ''
      while (!recu.includes('data: ')) {
        recu += decodeur.decode((await lecteur.read()).value, { stream: true })
      }
      expect(recu).toContain('"name":"Micro"')
      expect(recu).toContain('-18')

      controleur.abort()
      // Et retiré dès que la dernière page se ferme.
      await vi.waitFor(() => expect(demandes).toEqual([true, false]))
    } finally {
      await local.close()
    }
  })

  it("ne rouvre pas l'abonnement pour une deuxième régie", async () => {
    const demandes: boolean[] = []
    const local = new DisplayServer({
      runtime,
      assets,
      program: () => store.activeProgram(),
      onLevelsRequested: (actif) => demandes.push(actif),
      port: 0,
    })
    const url = await local.listen()

    try {
      const a = new AbortController()
      const b = new AbortController()
      await fetch(`${url}/display/audio`, { signal: a.signal })
      await vi.waitFor(() => expect(demandes).toEqual([true]))
      await fetch(`${url}/display/audio`, { signal: b.signal })

      // Deux pages ouvertes, un seul abonnement chez OBS.
      expect(demandes).toEqual([true])

      a.abort()
      // Et il ne se coupe pas tant qu'il reste quelqu'un.
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(demandes).toEqual([true])

      b.abort()
      await vi.waitFor(() => expect(demandes).toEqual([true, false]))
    } finally {
      await local.close()
    }
  })
})

/**
 * Ce qui se joue dans les autres salles, sur la fin **effective**.
 *
 * La position se cherchait dans une liste déjà filtrée sur les conférences, et
 * un créneau sans heure de fin explicite y était « en cours » pour toujours :
 * l'écran d'à côté annonçait le premier talk de la matinée jusqu'au soir. Le
 * calcul passe désormais par `timelinePosition`, sur tous les créneaux, et le
 * filtre sur les conférences vient après.
 */
describe('autres salles, fin effective', () => {
  const TRACK_2 = 'track-2-mf-1092'
  /** 08:50 → 09:40 UTC, le premier talk de Track #2. */
  const MATIN = 'cmq3nx20102h901ppuyjkennd'
  /** 10:00 → 10:50 UTC : celui qui se joue vraiment à l'heure du test. */
  const MIDI = 'cmqb69foj000p01nl361us8f0'

  async function voisine(): Promise<DisplayPayload['otherRooms'][number] | undefined> {
    const payload = (await (await fetch(`${origin}/display/data`)).json()) as DisplayPayload
    return payload.otherRooms.find((salle) => salle.roomId === TRACK_2)
  }

  it('annonce le talk qui se joue, pas celui du matin resté ouvert', async () => {
    // Le talk du matin perd son heure de fin : il ne reste que sa durée, comme
    // dans un export qui ne porte que des heures de début.
    const servi: Program = {
      ...program,
      sessions: program.sessions.map((session) =>
        session.id === MATIN
          ? { ...session, endsAt: null, endsAtMs: null, durationMinutes: 50 }
          : session,
      ),
    }
    store.saveProgram('hash-2', servi)
    runtime.setProgram('hash-2', servi)

    // L'horloge du fichier est à 10:20 UTC : la durée ferme le talk du matin à
    // 09:40, et c'est celui de 10:00 qui se joue.
    const vue = await voisine()
    expect(vue?.session?.id).toBe(MIDI)
    expect(vue?.running).toBe(true)
  })

  it('donne la conférence suivante quand rien ne se joue à côté', async () => {
    // 09:50 UTC : Track #2 est entre deux talks. Une salle vide n'annonce pas
    // « en ce moment », elle annonce l'heure du prochain.
    runtime.setServerTime(new Date(Date.parse('2026-10-30T09:50:00.000Z')).toISOString(), true)

    const vue = await voisine()
    expect(vue?.running).toBe(false)
    expect(vue?.session?.id).toBe(MIDI)
  })
})

/**
 * Charge du poste, servie hors du flux d'état.
 *
 * Le point à protéger n'est pas le chiffre : c'est qu'il ne voyage pas dans la
 * charge utile. Une valeur qui bouge chaque seconde y republierait tout le
 * diagnostic à chaque tic, alors qu'une salle au repos ne doit rien émettre.
 */
describe('charge du poste', () => {
  it('répond sur sa propre route', async () => {
    const reponse = await fetch(`${origin}/control/host`)
    expect(reponse.status).toBe(200)

    const charge = (await reponse.json()) as {
      cpu: number | null
      cores: number
      windowMs: number
      memory: { usedBytes: number; totalBytes: number } | null
    }
    expect(charge.cores).toBeGreaterThan(0)
    // La mémoire, elle, se lit dès le premier appel : c'est un instantané.
    expect(charge.memory?.totalBytes).toBeGreaterThan(0)
    expect(charge.memory?.usedBytes).toBeLessThanOrEqual(charge.memory?.totalBytes ?? 0)
    // Au premier relevé, aucune fenêtre n'est écoulée : le serveur l'avoue
    // plutôt que d'annoncer une machine au repos.
    expect(charge.cpu === null || (charge.cpu >= 0 && charge.cpu <= 1)).toBe(true)
  })

  it('reste hors de la charge utile envoyée aux pages', async () => {
    const payload = (await (await fetch(`${origin}/display/data`)).json()) as Record<string, unknown>
    expect(payload).not.toHaveProperty('hote')
    expect(JSON.stringify(payload)).not.toContain('cores')
  })

  it('relaie le relevé qu\'on lui confie', async () => {
    const local = new DisplayServer({
      runtime,
      assets,
      program: () => store.activeProgram(),
      hostLoad: () => ({
        cpu: 0.42,
        cores: 8,
        windowMs: 5_000,
        memory: { usedBytes: 11_000_000_000, totalBytes: 16_000_000_000 },
      }),
      port: 0,
    })
    const adresse = await local.listen()
    try {
      expect(await (await fetch(`${adresse}/control/host`)).json()).toEqual({
        cpu: 0.42,
        cores: 8,
        windowMs: 5_000,
        memory: { usedBytes: 11_000_000_000, totalBytes: 16_000_000_000 },
      })
    } finally {
      await local.close()
    }
  })
})
