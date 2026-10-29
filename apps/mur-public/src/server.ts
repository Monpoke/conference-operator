import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Config } from './config.js'
import { z } from 'zod'
import { HubFeed, ImageCache, ViewReporter, hubReader, hubViewsSender, type FeedState, type Log } from './hub.js'
import { CONTENT_SECURITY_POLICY, MUR_VIDE, faviconVersion, renderFavicon, renderPage } from './page.js'
import { RateLimiter } from './rate-limit.js'

export interface MurPublicServer {
  server: Server
  feed: HubFeed
  /** The views gathered for the hub; `null` without a token (`HUB_TOKEN`): nothing is counted. */
  views: ViewReporter | null
  /** `http://host:port` once listening. */
  url: string
  close: () => Promise<void>
}

/**
 * The public social page, on its own domain: `/` the page, `/mur.json` what it
 * polls, `/images/<clé>` the wall's images, `/sante` for the probes.
 *
 * `POST /vues` takes the posts a visitor saw, added up and sent to the hub every
 * half minute (`ViewReporter`).
 *
 * Every answer comes from memory; the hub is asked by the feed alone. What the
 * rate limit guards is this process — a flood from one address gets 429s, the
 * others keep their page.
 */
export async function startMurPublic(
  config: Config,
  options: { log?: Log; read?: () => Promise<unknown>; fetchImpl?: typeof fetch } = {},
): Promise<MurPublicServer> {
  const log: Log = options.log ?? ((level, message, context) => console[level === 'warn' ? 'warn' : 'log'](JSON.stringify({ level, message, ...context })))
  const feed = new HubFeed({ read: options.read ?? hubReader(config.hubUrl), pollMs: config.pollSeconds * 1000, log })
  const images = new ImageCache({ hubUrl: config.hubUrl, maxBytes: config.imagesCacheMb * 1024 * 1024, fetchImpl: options.fetchImpl })
  const pages = new RateLimiter(config.limitePages)
  const imageLimiter = new RateLimiter(config.limiteImages)
  const viewLimiter = new RateLimiter(config.limiteVues)
  const pruning = setInterval(() => {
    pages.prune()
    imageLimiter.prune()
    viewLimiter.prune()
  }, 60_000)
  const views = config.hubToken == null
    ? null
    : new ViewReporter({ send: hubViewsSender(config.hubUrl, config.hubToken), everyMs: config.vuesSeconds * 1000, log })
  if (views == null) log('info', 'vues en ligne non comptées : HUB_TOKEN absent')
  pruning.unref()

  let rendered: { etag: string | null; html: string } | null = null
  const page = (state: FeedState | null): string => {
    const etag = state?.etag ?? null
    if (rendered == null || rendered.etag !== etag) rendered = { etag, html: renderPage(state?.data ?? MUR_VIDE, config.reseaux) }
    return rendered.html
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((cause) => {
      log('warn', 'requête en échec', { url: request.url, erreur: cause instanceof Error ? cause.message : String(cause) })
      if (!response.headersSent) send(response, 500, 'text/plain; charset=utf-8', 'Erreur interne')
      else response.destroy()
    })
  })
  // A slow client holds a socket: short deadlines, nothing to upload here.
  server.requestTimeout = 10_000
  server.headersTimeout = 5_000
  server.keepAliveTimeout = 5_000

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    common(response)
    const url = new URL(request.url ?? '/', 'http://mur')
    const path = url.pathname
    const isVues = path === '/vues'
    const allowed = isVues ? request.method === 'POST' : request.method === 'GET' || request.method === 'HEAD'
    if (!allowed) {
      response.setHeader('allow', isVues ? 'POST' : 'GET, HEAD')
      return send(response, 405, 'text/plain; charset=utf-8', 'Méthode non autorisée')
    }

    if (path === '/sante') {
      const state = feed.state
      return send(response, 200, 'application/json', JSON.stringify({
        ok: true,
        revision: state?.data.revision ?? null,
        recuIlYA: state == null ? null : Math.round((Date.now() - state.receivedAt) / 1000),
        erreur: feed.lastError,
      }), { 'cache-control': 'no-store' })
    }

    const address = clientAddress(request, config.proxyHops)
    const isImage = path.startsWith('/images/')
    if (!(isImage ? imageLimiter : isVues ? viewLimiter : pages).take(address)) {
      response.setHeader('retry-after', '30')
      return send(response, 429, 'text/plain; charset=utf-8', 'Trop de requêtes : réessayez dans un instant.')
    }

    if (isVues) {
      const body = await readBody(request, MAX_VUES_BYTES)
      if (body == null) return send(response, 413, 'text/plain; charset=utf-8', 'Trop de vues d’un coup')
      let parsed: ReturnType<typeof vuesSchema.safeParse>
      try {
        parsed = vuesSchema.safeParse(JSON.parse(body))
      } catch {
        return send(response, 400, 'text/plain; charset=utf-8', 'JSON attendu')
      }
      if (!parsed.success) return send(response, 400, 'text/plain; charset=utf-8', '{"ids": […]} attendu')
      // Only the posts on the wall now, each once per report: a visitor counts a
      // card once per page load, and the page sends what it saw since its last.
      const known = feed.state?.postIds
      views?.add(new Set(parsed.data.ids.filter((id) => known?.has(id) === true)))
      response.writeHead(204, { 'cache-control': 'no-store' })
      response.end()
      return
    }

    if (path === '/' || path === '/index.html') {
      const state = feed.state
      return send(response, 200, 'text/html; charset=utf-8', page(state), {
        'content-security-policy': CONTENT_SECURITY_POLICY,
        // Asked again on every visit: the posts are in it.
        'cache-control': 'no-cache',
      }, request)
    }

    if (path === '/favicon.svg') {
      const data = feed.state?.data ?? MUR_VIDE
      const logo = data.logo == null ? null : await images.get(data.logo)
      // A logo named but not in yet: the initials stand in, and must not be
      // kept under the logo's version.
      const standIn = data.logo != null && logo == null
      const version = faviconVersion(data)
      const headers = {
        etag: `"${version}"`,
        // The page links the current version: that address is cached for good.
        // Any other (no version, an old one) is checked again on every use.
        'cache-control': standIn ? 'no-store' : url.searchParams.get('v') === version ? IMMUTABLE : 'no-cache',
        'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
      }
      if (!standIn && revalidated(request, headers.etag)) return notModified(response, headers)
      return send(response, 200, 'image/svg+xml', renderFavicon(data, logo), headers, request)
    }

    if (path === '/mur.json') {
      const state = feed.state
      if (state == null) {
        response.setHeader('retry-after', '10')
        return send(response, 503, 'application/json', JSON.stringify({ erreur: 'le mur n’est pas encore arrivé du hub' }), { 'cache-control': 'no-store' })
      }
      // A few seconds of shared cache: a proxy in front may answer for us.
      const headers = { etag: state.etag, 'cache-control': 'public, max-age=5' }
      if (revalidated(request, state.etag)) return notModified(response, headers)
      return send(response, 200, 'application/json', state.json, headers, request)
    }

    if (isImage) {
      const key = path.slice('/images/'.length)
      // Only what the wall draws now: this is not a door onto every image the hub holds.
      // A miss is never kept, by the browser or a proxy: the image may be on
      // the wall a minute later, or the hub may have it by then.
      if (!/^[0-9a-f]{64}$/.test(key) || feed.state?.images.has(key) !== true) {
        return send(response, 404, 'text/plain; charset=utf-8', 'Image inconnue', { 'cache-control': 'no-store' })
      }
      // The key is the image: the same address never stands for other bytes.
      // Immutable for the browsers; its ETag answers a forced reload with a 304.
      const headers = {
        etag: `"${key}"`,
        'cache-control': IMMUTABLE,
        // An SVG opened on its own must not run anything on this origin.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      }
      if (revalidated(request, headers.etag)) return notModified(response, headers)
      const image = await images.get(key)
      if (image == null) {
        return send(response, 404, 'text/plain; charset=utf-8', 'Image indisponible', { 'cache-control': 'no-store', 'retry-after': '30' })
      }
      // A video is read by ranges: Safari plays nothing from a server that ignores them.
      const range = byteRange(request.headers.range, image.bytes.byteLength)
      if (range === 'invalide') {
        return send(response, 416, 'text/plain; charset=utf-8', 'Plage invalide', { 'content-range': `bytes */${image.bytes.byteLength}` })
      }
      if (range != null) {
        return send(response, 206, image.type, image.bytes.subarray(range.start, range.end + 1), {
          ...headers,
          'accept-ranges': 'bytes',
          'content-range': `bytes ${range.start}-${range.end}/${image.bytes.byteLength}`,
        }, request)
      }
      return send(response, 200, image.type, image.bytes, { ...headers, 'accept-ranges': 'bytes' }, request)
    }

    return send(response, 404, 'text/plain; charset=utf-8', 'Page introuvable')
  }

  feed.start()
  views?.start()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => resolve())
  })
  const { port } = server.address() as AddressInfo
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host
  log('info', 'mur public prêt', { port, hub: config.hubUrl })

  return {
    server,
    feed,
    views,
    url: `http://${host}:${port}`,
    close: async () => {
      feed.stop()
      views?.stop()
      // What the visitors saw since the last report leaves with the process.
      await views?.flush()
      clearInterval(pruning)
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/**
 * The visitor, for the rate limit. Behind `hops` proxies that append to
 * `X-Forwarded-For`, it is the entry that many places from the right: the left
 * ones are whatever the client sent, and a client that forges them must not get
 * a fresh bucket per request.
 */
export function clientAddress(request: IncomingMessage, hops: number): string {
  const socket = request.socket.remoteAddress ?? 'inconnu'
  if (hops === 0) return socket
  const header = request.headers['x-forwarded-for']
  const entries = (Array.isArray(header) ? header.join(',') : (header ?? '')).split(',').map((entry) => entry.trim()).filter(Boolean)
  return entries[entries.length - hops] ?? entries[0] ?? socket
}

const IMMUTABLE = 'public, max-age=31536000, immutable'

/** What the page sends: the posts it saw since its last report. A wall holds 80 at most. */
const vuesSchema = z.object({ ids: z.array(z.string().min(1).max(40)).max(200) })
const MAX_VUES_BYTES = 16 * 1024

/** The request's body, or `null` past `max` bytes. */
async function readBody(request: IncomingMessage, max: number): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).byteLength
    if (size > max) return null
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * One `Range: bytes=…` over a file of `size` bytes, as `{ start, end }` (inclusive);
 * `null` without one, or for several (the whole file answers them); `'invalide'`
 * past the end.
 */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalide' {
  const match = header == null ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match == null || (match[1] === '' && match[2] === '')) return null
  const [start, end] = match[1] === ''
    ? [Math.max(0, size - Number(match[2])), size - 1]
    : [Number(match[1]), match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)]
  return start > end || start >= size ? 'invalide' : { start, end }
}

/** `If-None-Match` names this ETag — alone, in a list, or weak. */
function revalidated(request: IncomingMessage, etag: string): boolean {
  const header = request.headers['if-none-match']
  if (header == null) return false
  return header.split(',').some((tag) => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag)
}

function notModified(response: ServerResponse, headers: Record<string, string>): void {
  response.writeHead(304, headers)
  response.end()
}

function common(response: ServerResponse): void {
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('referrer-policy', 'strict-origin-when-cross-origin')
}

function send(
  response: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  headers: Record<string, string> = {},
  request?: IncomingMessage,
): void {
  response.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), ...headers })
  response.end(request?.method === 'HEAD' ? undefined : body)
}
