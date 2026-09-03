import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeProgram } from '@cloudnord/program'
import { AssetCache } from '../src/core/assets.js'
import { DisplayServer } from '../src/core/display-server.js'
import { LocalStore } from '../src/core/store.js'
import { RoomRuntime } from '../src/core/runtime.js'
import {
  developmentAssets,
  productionAssets,
  renderControlShell,
} from '../src/core/control-shell.js'

/**
 * La fenêtre de l'opérateur, servie par le poste.
 *
 * Ce qui est vérifié ici n'est pas le rendu — il l'est chez `@cloudnord/regie-web`,
 * qui monte les composants — mais les deux choses que seul le poste de salle
 * peut garantir : que la page part avec l'état complet dedans, et qu'elle ne
 * demande rien à une autre origine que la sienne.
 */

const program = normalizeProgram(
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url),
      ),
      'utf8',
    ),
  ),
)

const TRACK_1 = 'track-1-teilhard-de-chardin'

let dir: string
let store: LocalStore
let server: DisplayServer
let origin: string

/**
 * Un poste de salle, sans bundle par défaut.
 *
 * `bundleRegie` est passé explicitement partout : la résolution réelle remonte
 * les dossiers jusqu'à un `dist/`, et un build laissé sur la machine ferait
 * passer ou échouer ces tests selon la machine. Le défaut se découvre en CI,
 * une fois, et on ne sait pas dire depuis quand il dure.
 */
async function demarrer(
  options: {
    viteOrigin?: string | null
    bundleRegie?: () => { directory: string; manifest: string } | null
  } = {},
): Promise<void> {
  const runtime = new RoomRuntime(store, {}, () => Date.parse('2026-10-30T10:20:00.000Z'))
  runtime.setRoomId(TRACK_1)
  runtime.setProgram('hash-1', program)
  server = new DisplayServer({
    runtime,
    assets: new AssetCache(store, join(dir, 'assets')),
    program: () => store.activeProgram(),
    roomName: () => 'Track #1 — Teilhard de Chardin',
    event: () => ({ name: 'Cloud Nord 2026', shortName: 'Cloud Nord' }),
    port: 0,
    bundleRegie: () => null,
    ...options,
  })
  origin = await server.listen()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-regie-'))
  store = new LocalStore(':memory:')
  store.saveProgram('hash-1', program)
})

afterEach(async () => {
  await server.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('la coquille', () => {
  it('rend le point de editing du bundle, et plus le gabarit', async () => {
    await demarrer({ viteOrigin: 'http://127.0.0.1:5174' })

    const reponse = await fetch(`${origin}/regie`)
    const html = await reponse.text()

    expect(reponse.status).toBe(200)
    expect(html).toContain('id="regie-root"')
    /*
     * L'ancienne page inlinait tout : la feuille figée dans un `<style>`, la
     * machine à états et trois mille lignes de code dans deux `<script>`, et le
     * balisage des sept modales. Rien de cela ne doit plus partir — ce qui
     * reste est la coquille, l'état de la salle, et des balises vers des
     * fichiers servis par ce même poste.
     */
    expect(html).not.toContain('<style>')
    expect(html).not.toContain('id="modale-vod"')
    // L'état embarqué domine désormais la page, et c'est le but.
    const etat = /<script id="etat-initial"[^>]*>(.*?)<\/script>/s.exec(html)![1]!
    expect(html.length - etat.length).toBeLessThan(1_500)
  })

  it('rend un document complet et clos', async () => {
    // Repris des garde-fous des pages-gabarits : une coquille tronquée se
    // rendait quand même, en partie, et le défaut se voyait à l'écran sans
    // qu'on sache d'où il venait.
    await demarrer({ viteOrigin: 'http://127.0.0.1:5174' })
    const html = await (await fetch(`${origin}/regie`)).text()

    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html.trimEnd().endsWith('</html>')).toBe(true)
  })

  it('embarque l’état complet, parce qu’un F5 arrive toujours en plein talk', async () => {
    await demarrer({ viteOrigin: 'http://127.0.0.1:5174' })

    const html = await (await fetch(`${origin}/regie`)).text()
    const brut = /<script id="etat-initial" type="application\/json">(.*?)<\/script>/s.exec(html)
    const etat = JSON.parse(brut![1]!.replace(/\\u003c/g, '<')) as { roomName: string }

    // Attendre le premier message du flux pour peindre quoi que ce soit
    // donnerait une demi-seconde d'écran vide au moment exact où l'opérateur
    // vient de perdre sa fenêtre.
    expect(etat.roomName).toBe('Track #1 — Teilhard de Chardin')
  })

  it('ne se laisse jamais mettre en cache : elle porte l’état de la salle', async () => {
    await demarrer({ viteOrigin: 'http://127.0.0.1:5174' })
    const reponse = await fetch(`${origin}/regie`)
    expect(reponse.headers.get('cache-control')).toBe('no-store')
  })

  it('sert les fichiers hachés du bundle, et les laisse être mis en cache', async () => {
    const bundle = bundleFactice()
    await demarrer({ bundleRegie: () => bundle })

    const html = await (await fetch(`${origin}/regie`)).text()
    expect(html).toContain('src="/regie/assets/index-abc123.js"')
    expect(html).toContain('href="/regie/assets/index-def456.css"')

    const asset = await fetch(`${origin}/regie/assets/index-abc123.js`)
    expect(asset.status).toBe(200)
    /*
     * Les noms portent une empreinte, d'où `immutable` : la régie est rouverte
     * plusieurs fois par jour sur un poste de salle, et rien ne justifie de
     * relire le même mégaoctet à chaque fois.
     */
    expect(asset.headers.get('cache-control')).toContain('immutable')
  })

  it('dit quoi faire quand le bundle manque, plutôt que de rendre un 404', async () => {
    await demarrer()

    const reponse = await fetch(`${origin}/regie`)

    // Ce n'est pas un état d'exploitation : l'empaquetage embarque le bundle.
    // Un 404 enverrait chercher du côté de l'adresse.
    expect(reponse.status).toBe(503)
    expect(await reponse.text()).toContain('pnpm --filter @cloudnord/regie-web build')
  })
})

describe('développement', () => {
  it('pointe la coquille sur Vite, et proxifie ce que Vite sait rendre', async () => {
    /*
     * Le sens du proxy est imposé : c'est le poste qui porte le flux d'état,
     * les actions et le vumètre, tous sur son origine. Mettre Vite devant
     * demanderait de proxifier un SSE et un WebSocket OBS pour le seul confort
     * du rechargement à chaud.
     */
    const vite = Fastify({ logger: false })
    vite.get('/regie/src/main.ts', async (_request, reply) => {
      reply.header('content-type', 'text/javascript')
      return reply.send('// servi par Vite')
    })
    const origineVite = await vite.listen({ host: '127.0.0.1', port: 0 })

    try {
      await demarrer({ viteOrigin: origineVite })

      const html = await (await fetch(`${origin}/regie`)).text()
      expect(html).toContain('src="/regie/@vite/client"')
      expect(html).toContain('src="/regie/src/main.ts"')

      // Et le poste sert vraiment ce que Vite lui donne, sur sa propre origine.
      const module = await fetch(`${origin}/regie/src/main.ts`)
      expect(module.status).toBe(200)
      expect(await module.text()).toBe('// servi par Vite')
    } finally {
      await vite.close()
    }
  })

  it('garde la coquille pour lui, même derrière le proxy', async () => {
    // Elle porte l'état embarqué : la laisser au proxy rendrait la page que
    // Vite sert depuis `index.html`, sans état dedans.
    const vite = Fastify({ logger: false })
    vite.get('/regie', async (_request, reply) => reply.send('coquille de Vite'))
    const origineVite = await vite.listen({ host: '127.0.0.1', port: 0 })

    try {
      await demarrer({ viteOrigin: origineVite })
      const html = await (await fetch(`${origin}/regie`)).text()
      expect(html).toContain('id="etat-initial"')
      expect(html).not.toContain('coquille de Vite')
    } finally {
      await vite.close()
    }
  })

  it('préfère Vite au bundle construit quand les deux sont là', async () => {
    const bundle = bundleFactice()
    await demarrer({ bundleRegie: () => bundle, viteOrigin: 'http://127.0.0.1:1' })

    /*
     * L'ordre inverse semblait plus prudent — un poste installé n'a pas de
     * Vite, une variable qui traîne ne doit pas le détourner — et il rendait le
     * développement impossible. `pnpm test` construit le bundle : un `dist/`
     * vieux de trois jours prenait alors le pas sur le serveur qui tourne. On
     * développait sur une régie compilée, sans rechargement à chaud, et
     * l'extension Vue refusait d'inspecter une page qu'elle voyait en mode
     * production.
     *
     * Un `dist/` est un artefact ; une origine Vite est une intention.
     */
    const html = await (await fetch(`${origin}/regie`)).text()
    expect(html).toContain('@vite/client')
    expect(html).not.toContain('/regie/assets/index-abc123.js')
  })

  it('sert le bundle dès qu’aucune origine Vite n’est annoncée', async () => {
    // Le cas du poste installé : la variable n'y est jamais posée.
    const bundle = bundleFactice()
    await demarrer({ bundleRegie: () => bundle })

    const html = await (await fetch(`${origin}/regie`)).text()
    expect(html).toContain('/regie/assets/index-abc123.js')
    expect(html).not.toContain('@vite/client')
  })
})

describe('autonomie de la page', () => {
  it('ne référence aucune ressource hors de son origine', () => {
    const html = renderControlShell({
      initialPayload: { roomName: 'Track #1' } as never,
      assets: productionAssets(manifesteTemporaire()),
      eventName: 'Cloud Nord 2026',
    })

    /*
     * L'invariant, sous la forme qu'il a prise depuis la console : aucune
     * ressource hors de l'origine servie. Il pèse plus lourd ici — la machine
     * de salle tourne parfois sans réseau du tout.
     */
    for (const url of [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((trouve) => trouve[1]!)) {
      expect(url.startsWith('/')).toBe(true)
    }
  })

  it('donne à Vite le même préfixe, pour que le développement ne triche pas', () => {
    const assets = developmentAssets()
    for (const url of [...assets.scripts, ...assets.styles]) {
      expect(url.startsWith('/regie/')).toBe(true)
    }
  })

  it('titre la fenêtre avec l’événement, qui n’est pas une constante du binaire', () => {
    const html = renderControlShell({
      initialPayload: {} as never,
      assets: { scripts: [], styles: [] },
      eventName: 'Cloud Nord 2027',
    })

    // C'est la même machine qui servira l'édition suivante, et la barre de
    // fenêtre est le premier endroit où un nom périmé se remarque.
    expect(html).toContain('<title>Régie — Cloud Nord 2027</title>')
  })

  it('échappe ce qui pourrait fermer la balise du script d’état', () => {
    const html = renderControlShell({
      initialPayload: { roomName: '</script><script>alert(1)</script>' } as never,
      assets: { scripts: [], styles: [] },
    })

    // Le nom d'une salle vient du hub, pas du poste : il n'a rien à faire dans
    // la grammaire de la page qui le transporte.
    expect(html).not.toContain('</script><script>alert(1)')
    expect(html).toContain('\\u003c/script>')
  })
})

/** Un manifeste Vite minimal, pour lire les assets sans construire le bundle. */
function manifesteTemporaire(): string {
  const dossier = join(dir, '.vite')
  mkdirSync(dossier, { recursive: true })
  const chemin = join(dossier, 'manifest.json')
  writeFileSync(
    chemin,
    JSON.stringify({
      'index.html': { file: 'assets/index-abc123.js', css: ['assets/index-def456.css'] },
    }),
  )
  return chemin
}

/** Le même, avec les fichiers derrière : de quoi servir pour de vrai. */
function bundleFactice(): { directory: string; manifest: string } {
  const manifest = manifesteTemporaire()
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'export const rien = 0\n')
  writeFileSync(join(dir, 'assets', 'index-def456.css'), '.rien{}\n')
  return { directory: dir, manifest }
}
