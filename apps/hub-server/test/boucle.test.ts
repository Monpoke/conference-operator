import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BOUCLE, contract, hubSettingsPatchSchema } from '@conference-operator/contract'
import { openHubDatabase } from '../src/db.js'
import { AssetStore } from '../src/services/assets.js'
import { SettingsService } from '../src/services/sessions.js'
import { createHub, type Hub } from '../src/server.js'
import { provisionOperator } from '../src/operators.js'
import { previewTime } from '../src/pages/boucle-preview.js'

/**
 * The welcome loop's content, on the hub side: a setting saved one panel at a
 * time, the program's partners offered to lay out, and images an organiser drops
 * from the console — kept where the rooms already look for the program's.
 */

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)
const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'control-password-2026' }
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'
const TRACK_1 = 'track-1-teilhard-de-chardin'
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

/** The smallest PNG there is: a transparent pixel. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

describe('the loop settings', () => {
  it('merge section by section', () => {
    const settings = new SettingsService(openHubDatabase(':memory:').orm)
    const pages = [{ titre: 'Merci', duree: null, rangs: [{ taille: 1, logos: [{ sponsor: 'mtg', nom: 'MTG', logo: null, echelle: 0.7 }] }] }]
    settings.update({ boucle: { sponsorPages: pages, merciSponsors: 'Merci !' } })

    // The messages panel saves its own section. The sponsor pages laid out by
    // hand must not go back to automatic along the way.
    const after = settings.update(
      hubSettingsPatchSchema.parse({ boucle: { messages: { ...DEFAULT_BOUCLE.messages, silence: { texte: 'Chut' } } } }),
    )
    expect(after.boucle.messages.silence).toEqual({ texte: 'Chut', sousTitre: '', effet: 'claque' })
    expect(after.boucle.messages.bienvenue).toEqual(DEFAULT_BOUCLE.messages.bienvenue)
    expect(after.boucle.sponsorPages).toEqual(pages)
    expect(after.boucle.merciSponsors).toBe('Merci !')

    // `null` is a value: back to the automatic layout, and the rest stays.
    const automatic = settings.update({ boucle: { sponsorPages: null } })
    expect(automatic.boucle.sponsorPages).toBeNull()
    expect(automatic.boucle.merciSponsors).toBe('Merci !')

    // Another panel entirely leaves the loop alone.
    expect(settings.update({ autoEndGraceMinutes: 9 }).boucle.merciSponsors).toBe('Merci !')
  })
})

describe('the loop images in the asset store', () => {
  let dir: string
  let assets: AssetStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hub-boucle-'))
    assets = new AssetStore(openHubDatabase(':memory:').orm, join(dir, 'assets'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('fetches the addresses and skips the uploads', async () => {
    const fetchImpl = vi.fn(async () => new Response('PNG', { headers: { 'content-type': 'image/png' } }))
    const report = await assets.prefetchUrls(
      ['https://cdn.exemple/logo.png', `hub-image:${'a'.repeat(64)}.png`, 'https://cdn.exemple/logo.png'],
      fetchImpl as unknown as typeof fetch,
    )
    expect(report).toMatchObject({ downloaded: 1, failed: [] })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(assets.previewUrl('https://cdn.exemple/logo.png')).toBe(`/assets/${sha('https://cdn.exemple/logo.png')}`)
    expect(assets.previewUrl('https://cdn.exemple/other.png')).toBeNull()
  })

  it('keeps an upload under the hash of its reference', async () => {
    const ref = `hub-image:${sha(PIXEL)}.png`
    await assets.store(ref, PIXEL, 'image/png')
    // The key a room computes from the reference, as it does from an address.
    expect(await assets.read(sha(ref))).toEqual({ bytes: PIXEL, contentType: 'image/png' })
    expect(assets.has(ref)).toBe(true)
  })
})

describe('the loop over the wire', () => {
  let hub: Hub
  let origin: string
  let admin: ContractRouterClient<typeof contract>
  let dir: string

  beforeEach(async () => {
    // A database on disk, in a temporary folder: the asset store lives beside
    // it, and uploads must not land in the working copy.
    dir = mkdtempSync(join(tmpdir(), 'hub-boucle-e2e-'))
    hub = await createHub({
      port: 0,
      host: '127.0.0.1',
      databasePath: join(dir, 'hub.db'),
      publicUrl: 'http://127.0.0.1',
      authSecret: 'test-secret-'.padEnd(48, 'x'),
      logLevel: 'fatal',
      devicePollInterval: '1s',
    })
    await hub.app.listen({ port: 0, host: '127.0.0.1' })
    const address = hub.app.server.address()
    origin = `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`
    await provisionOperator(hub.auth, OPERATOR)
    admin = client({ authorization: `Bearer ${await signIn()}` })
  })

  afterEach(async () => {
    await hub.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function client(headers: Record<string, string>): ContractRouterClient<typeof contract> {
    return createORPCClient(new RPCLink({ origin, url: '/rpc', headers: () => headers }))
  }

  async function signIn(): Promise<string> {
    const response = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
    })
    return ((await response.json()) as { token: string }).token
  }

  function importProgram(): void {
    hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
  }

  it('offers no partner before a program exists', async () => {
    expect(await admin.boucle.catalogue()).toEqual({ sponsors: [], pagesParDefaut: [] })
  })

  it('offers each partner once, whatever its packs, and the automatic pages', async () => {
    importProgram()
    const { sponsors, pagesParDefaut } = await admin.boucle.catalogue()

    // Three packs upstream, three identifiers: one partner here.
    const ape = sponsors.filter((sponsor) => sponsor.name.toLowerCase() === 'ape factory')
    expect(ape).toHaveLength(1)
    expect(ape[0]!.tiers.length).toBeGreaterThan(1)
    expect(new Set(sponsors.map((sponsor) => sponsor.key)).size).toBe(sponsors.length)

    // Not downloaded yet: the console shows the upstream copy meanwhile.
    const withLogo = sponsors.find((sponsor) => sponsor.logoPreview != null)
    expect(withLogo?.logoPreview).toMatch(/^https?:\/\//)

    // The first tier has no title: its logos are the page.
    expect(pagesParDefaut.length).toBeGreaterThan(0)
    expect(pagesParDefaut[0]!.titre).toBe('')
    for (const page of pagesParDefaut) for (const row of page.rangs) expect(row.logos.length).toBeLessThanOrEqual(4)
  })

  it('serves an uploaded image where the rooms look for it', async () => {
    const { ref, preview } = await admin.boucle.uploadImage({
      contentType: 'image/png',
      base64: PIXEL.toString('base64'),
    })
    expect(ref).toBe(`hub-image:${sha(PIXEL)}.png`)
    expect(preview).toBe(`/assets/${sha(ref)}`)

    const response = await fetch(`${origin}${preview}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PIXEL)

    const unknown = `hub-image:${'b'.repeat(64)}.png`
    expect(await admin.boucle.previews({ refs: [ref, unknown, 'https://cdn.exemple/x.png'] })).toEqual({
      [ref]: preview,
      [unknown]: null,
      // Not held yet: the console's browser fetches it from the source meanwhile.
      'https://cdn.exemple/x.png': 'https://cdn.exemple/x.png',
    })
  })

  it('takes an image heavier than the default body limit', async () => {
    // A 1.5 MB PNG — well past Fastify's 1 MiB default, under the 2.5 MB ceiling.
    const heavy = Buffer.concat([PIXEL, Buffer.alloc(1_500_000, 7)])
    const { ref } = await admin.boucle.uploadImage({ contentType: 'image/png', base64: heavy.toString('base64') })
    expect(ref).toBe(`hub-image:${sha(heavy)}.png`)
  })

  it('refuses what is not the announced image', async () => {
    await expect(
      admin.boucle.uploadImage({ contentType: 'image/png', base64: Buffer.from('%PDF-1.7').toString('base64') }),
    ).rejects.toThrow(/pas l'image annoncée/)
    await expect(
      admin.boucle.uploadImage({ contentType: 'image/svg+xml', base64: Buffer.from('hello').toString('base64') }),
    ).rejects.toThrow(/pas l'image annoncée/)
    const tooHeavy = Buffer.concat([PIXEL, Buffer.alloc(2_400_000)])
    await expect(
      admin.boucle.uploadImage({ contentType: 'image/png', base64: tooHeavy.toString('base64') }),
    ).rejects.toBeDefined()

    const svg = await admin.boucle.uploadImage({
      contentType: 'image/svg+xml',
      base64: Buffer.from('\n<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
    })
    expect(svg.ref).toMatch(/^hub-image:[0-9a-f]{64}\.svg$/)
    const served = await fetch(`${origin}${svg.preview}`)
    expect(served.headers.get('content-type')).toBe('image/svg+xml')
    // Opened directly, an uploaded SVG must not run anything in the console's origin.
    expect(served.headers.get('content-security-policy')).toContain('sandbox')
  })

  it('previews the room screen for a signed-in operator only', async () => {
    importProgram()
    const anonymous = await fetch(`${origin}/boucle/apercu`)
    expect(anonymous.status).toBe(401)

    await admin.settings.update({ boucle: { merciSponsors: 'Merci à tous nos partenaires' } })
    const headers = { authorization: `Bearer ${await signIn()}` }
    const page = await fetch(`${origin}/boucle/apercu?salle=${TRACK_1}`, { headers })
    expect(page.status).toBe(200)
    const html = await page.text()
    // The room's own document, with the state a room would build from its sync.
    expect(html).toContain('<div id="stage">')
    const state = JSON.parse(html.match(/<script id="etat-initial" type="application\/json">(.*?)<\/script>/)![1]!)
    expect(state.roomName).toMatch(/Track #1/)
    expect(state.boucle.merciSponsors).toBe('Merci à tous nos partenaires')
    expect(state.boucle.sponsorPages.length).toBeGreaterThan(0)
    expect(state.agenda.length).toBeGreaterThan(0)
    // No stream: the page is reloaded after a save.
    expect(html).toContain('window.__PREVIEW__ = true')
  })

  it('draws the preview at another time, and the hub clock does not move', async () => {
    importProgram()
    const before = hub.services.clock.now()
    const html = await (await fetch(`${origin}/boucle/apercu?heure=09:15`, {
      headers: { authorization: `Bearer ${await signIn()}` },
    })).text()
    const state = JSON.parse(html.match(/<script id="etat-initial" type="application\/json">(.*?)<\/script>/)![1]!)
    // 09:15 in Paris on the event's day: the opening keynote is on.
    expect(state.state.currentSession.title).toBe("Keynote d'ouverture")
    expect(Math.abs(hub.services.clock.now() - before)).toBeLessThan(60_000)
  })

  it('previews a talk’s VOD intro and outro for an operator only', async () => {
    importProgram()
    const talk = 'cmq3nx20102h901ppuyjkennd'
    expect((await fetch(`${origin}/montage/apercu/${talk}`)).status).toBe(401)

    await admin.settings.update({ boucle: { merciSponsors: 'Merci à nos partenaires' } })
    const headers = { authorization: `Bearer ${await signIn()}` }
    const intro = await (await fetch(`${origin}/montage/apercu/${talk}`, { headers })).text()
    const data = JSON.parse(intro.match(/<script id="vod-donnees" type="application\/json">(.*?)<\/script>/)![1]!)
    // The page the worker captures, playing: nothing frozen here.
    expect(data.clip).toBe('intro')
    expect(data.habillage.speakers.map((s: { name: string }) => s.name)).toEqual(['Guillaume Leroy', 'Mazlum Tosun'])
    expect(intro).not.toContain('__VOD_CAPTURE__ = true')

    const outro = await (await fetch(`${origin}/montage/apercu/${talk}?clip=outro`, { headers })).text()
    expect(outro).toContain('"clip":"outro"')
    expect(outro).toContain('Merci à nos partenaires')
  })

  it('opens the preview to the public with the key, and only with it', async () => {
    importProgram()
    const key = 'Pk9-public_key_for_the_loop_2026'
    expect((await fetch(`${origin}/boucle/apercu?cle=${key}`)).status).toBe(401)

    await admin.settings.update({ boucle: { lienPublic: key } })
    const open = await fetch(`${origin}/boucle/apercu?cle=${key}&salle=${TRACK_1}`)
    expect(open.status).toBe(200)
    expect(await open.text()).toContain('<div id="stage">')
    expect((await fetch(`${origin}/boucle/apercu?cle=${key.slice(0, -1)}x`)).status).toBe(401)

    // Taking the link back cuts it.
    await admin.settings.update({ boucle: { lienPublic: null } })
    expect((await fetch(`${origin}/boucle/apercu?cle=${key}`)).status).toBe(401)
  })

  it('previews the other rooms\' schedules with their durations', async () => {
    importProgram()
    await admin.settings.update({
      boucle: { plannings: { 'hands-on': { afficher: false, duree: 15 }, 'track-2-mf-1092': { afficher: true, duree: 30 } } },
    })
    const html = await (await fetch(`${origin}/boucle/apercu?salle=${TRACK_1}`, {
      headers: { authorization: `Bearer ${await signIn()}` },
    })).text()
    const state = JSON.parse(html.match(/<script id="etat-initial" type="application\/json">(.*?)<\/script>/)![1]!)
    expect(state.plannings.map((p: { roomId: string; duree: number }) => [p.roomId, p.duree])).toEqual([['track-2-mf-1092', 30]])
    expect(state.plannings[0].agenda.length).toBeGreaterThan(0)
  })

  it('draws the global screen: every room\'s day, none of its own', async () => {
    importProgram()
    const key = 'Pk9-public_key_for_the_loop_2026'
    await admin.settings.update({ boucle: { lienPublic: key } })
    const html = await (await fetch(`${origin}/boucle/apercu?cle=${key}&salle=global`)).text()
    const state = JSON.parse(html.match(/<script id="etat-initial" type="application\/json">(.*?)<\/script>/)![1]!)
    expect(state.state.roomId).toBeNull()
    expect(state.agenda).toEqual([])
    expect(state.plannings.map((p: { roomId: string }) => p.roomId)).toEqual([TRACK_1, 'track-2-mf-1092', 'hands-on'])
    // The page fetches its state again, with the same key and the same screen.
    expect(html).toContain(`boucle.suivre("/boucle/apercu/etat?salle=global&cle=${key}", 20000)`)
    const feed = await fetch(`${origin}/boucle/apercu/etat?salle=global&cle=${key}`)
    expect(feed.status).toBe(200)
    expect(((await feed.json()) as { plannings: unknown[] }).plannings).toHaveLength(3)
    expect((await fetch(`${origin}/boucle/apercu/etat?salle=global`)).status).toBe(401)
  })

  it('does not refetch a preview drawn at a set time', async () => {
    importProgram()
    const html = await (await fetch(`${origin}/boucle/apercu?heure=10:00`, {
      headers: { authorization: `Bearer ${await signIn()}` },
    })).text()
    expect(html).not.toContain('boucle.suivre(')
  })

  it('holds one scene when asked', async () => {
    importProgram()
    const html = await (await fetch(`${origin}/boucle/apercu?scene=5`, {
      headers: { authorization: `Bearer ${await signIn()}` },
    })).text()
    expect(html).toContain("boucle.allerA(5, 'cut')")
  })

  it('sends the loop down with the sync', async () => {
    importProgram()
    hub.services.rooms.upsert({
      id: TRACK_1,
      name: 'Track #1',
      trackId: TRACK_1,
      obs: {
        A: { url: 'ws://127.0.0.1:4455', password: null },
        B: { url: 'ws://127.0.0.1:4456', password: null },
      },
      sceneRoles: { A: {}, B: {} },
    })
    await admin.settings.update({ boucle: { merciSponsors: 'Merci\nà eux' } })

    const room = client(await pairRoom())
    const sync = await room.rooms.sync({ since: null })
    expect(sync.boucle.merciSponsors).toBe('Merci\nà eux')
    expect(sync.boucle.messages).toEqual(DEFAULT_BOUCLE.messages)
  }, 20_000)

  async function pairRoom(): Promise<Record<string, string>> {
    const codeResponse = await fetch(`${origin}/api/auth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID }),
    })
    const request = (await codeResponse.json()) as { device_code: string; user_code: string }
    await admin.devices.approve({ userCode: request.user_code, clientId: CLIENT_ID, roomId: TRACK_1, label: 'PC salle 1' })
    await new Promise((resolve) => setTimeout(resolve, 1_100))
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
    const machine = client({ authorization: `Bearer ${granted.access_token}`, 'x-room-client-id': CLIENT_ID })
    const { token } = await machine.devices.claim()
    return { authorization: `Bearer ${token}` }
  }
})

describe('the preview time', () => {
  it('reads the time in the event timezone, on the event day by default', () => {
    expect(previewTime({ heure: '08:30' }, 'Europe/Paris', '2026-10-30T07:00:00.000+00:00'))
      .toBe(Date.parse('2026-10-30T07:30:00Z'))
    // A summer day is two hours ahead of UTC, not one.
    expect(previewTime({ heure: '08:30', jour: '2026-07-01' }, 'Europe/Paris', null))
      .toBe(Date.parse('2026-07-01T06:30:00Z'))
  })

  it('leaves the hub clock alone when the time is absent or malformed', () => {
    expect(previewTime({ heure: null }, 'Europe/Paris', null)).toBeNull()
    expect(previewTime({ heure: '9h' }, 'Europe/Paris', null)).toBeNull()
  })
})
