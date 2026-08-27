import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeProgram } from '@cloudnord/program'
import { AssetCache } from '../src/core/assets.js'
import { DisplayServer } from '../src/core/display-server.js'
import { LocalStore } from '../src/core/store.js'
import { RoomRuntime } from '../src/core/runtime.js'
import {
  assetsDeDeveloppement,
  assetsDeProduction,
  renderRegieShell,
} from '../src/core/regie-shell.js'

/**
 * La régie refaite, servie à côté de l'ancienne.
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
    bundleRegie?: () => { dossier: string; manifeste: string } | null
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
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-regie-v2-'))
  store = new LocalStore(':memory:')
  store.saveProgram('hash-1', program)
})

afterEach(async () => {
  await server.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('adresse parallèle', () => {
  it('sert une coquille distincte, sans toucher à l’ancienne régie', async () => {
    await demarrer({ viteOrigin: 'http://127.0.0.1:5174' })

    const ancienne = await fetch(`${origin}/regie`)
    const nouvelle = await fetch(`${origin}/regie-v2`)

    /*
     * Les deux répondent, et c'est tout l'objet de la coexistence : les deux
     * fenêtres s'ouvrent côte à côte sur la même salle et le même flux, une
     * journée d'exploitation réelle décide, et la bascule ne se fait qu'après.
     */
    expect(ancienne.status).toBe(200)
    expect(nouvelle.status).toBe(200)
    expect(await nouvelle.text()).toContain('id="regie-root"')
  })

  it('embarque l’état complet, parce qu’un F5 arrive toujours en plein talk', async () => {
    await demarrer({ viteOrigin: 'http://127.0.0.1:5174' })

    const html = await (await fetch(`${origin}/regie-v2`)).text()
    const brut = /<script id="etat-initial" type="application\/json">(.*?)<\/script>/s.exec(html)
    const etat = JSON.parse(brut![1]!.replace(/\\u003c/g, '<')) as { roomName: string }

    // Attendre le premier message du flux pour peindre quoi que ce soit
    // donnerait une demi-seconde d'écran vide au moment exact où l'opérateur
    // vient de perdre sa fenêtre.
    expect(etat.roomName).toBe('Track #1 — Teilhard de Chardin')
  })

  it('ne se laisse jamais mettre en cache : elle porte l’état de la salle', async () => {
    await demarrer({ viteOrigin: 'http://127.0.0.1:5174' })
    const reponse = await fetch(`${origin}/regie-v2`)
    expect(reponse.headers.get('cache-control')).toBe('no-store')
  })

  it('sert les fichiers hachés du bundle, et les laisse être mis en cache', async () => {
    const bundle = bundleFactice()
    await demarrer({ bundleRegie: () => bundle })

    const html = await (await fetch(`${origin}/regie-v2`)).text()
    expect(html).toContain('src="/regie-v2/assets/index-abc123.js"')
    expect(html).toContain('href="/regie-v2/assets/index-def456.css"')

    const asset = await fetch(`${origin}/regie-v2/assets/index-abc123.js`)
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

    const reponse = await fetch(`${origin}/regie-v2`)

    // Ce n'est pas un état d'exploitation : l'empaquetage embarque le bundle.
    // Un 404 enverrait chercher du côté de l'adresse.
    expect(reponse.status).toBe(503)
    expect(await reponse.text()).toContain('pnpm --filter @cloudnord/regie-web build')
  })
})

describe('autonomie de la page', () => {
  it('ne référence aucune ressource hors de son origine', () => {
    const html = renderRegieShell({
      initialPayload: { roomName: 'Track #1' } as never,
      assets: assetsDeProduction(manifesteTemporaire()),
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
    const assets = assetsDeDeveloppement()
    for (const url of [...assets.scripts, ...assets.styles]) {
      expect(url.startsWith('/regie-v2/')).toBe(true)
    }
  })

  it('titre la fenêtre avec l’événement, qui n’est pas une constante du binaire', () => {
    const html = renderRegieShell({
      initialPayload: {} as never,
      assets: { scripts: [], styles: [] },
      eventName: 'Cloud Nord 2027',
    })

    // C'est la même machine qui servira l'édition suivante, et la barre de
    // fenêtre est le premier endroit où un nom périmé se remarque.
    expect(html).toContain('<title>Régie — Cloud Nord 2027</title>')
  })

  it('échappe ce qui pourrait fermer la balise du script d’état', () => {
    const html = renderRegieShell({
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
function bundleFactice(): { dossier: string; manifeste: string } {
  const manifeste = manifesteTemporaire()
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'export const rien = 0\n')
  writeFileSync(join(dir, 'assets', 'index-def456.css'), '.rien{}\n')
  return { dossier: dir, manifeste }
}
