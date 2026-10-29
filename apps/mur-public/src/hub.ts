import { createHash } from 'node:crypto'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { murPublicSchema, type contract, type MurPublic } from '@conference-operator/contract'

export type Log = (level: 'info' | 'warn', message: string, context?: Record<string, unknown>) => void

/** What the hub last said, ready to serve: the JSON is serialised once per revision. */
export interface FeedState {
  data: MurPublic
  json: string
  etag: string
  /** The image keys this state draws — the only ones `/images/` serves. */
  images: Set<string>
  /** The posts this state draws — the only ones `/vues` counts. */
  postIds: Set<string>
  receivedAt: number
}

/** The hub's `wall.public`, anonymous, over HTTP. */
export function hubReader(hubUrl: string): () => Promise<unknown> {
  const base = new URL(hubUrl)
  const client: ContractRouterClient<typeof contract> = createORPCClient(
    new RPCLink({ origin: base.origin, url: `${base.pathname.replace(/\/+$/, '')}/rpc` as `/${string}` }),
  )
  return () => client.wall.public()
}

/** The hub's `wall.onlineViews`, with the service's token. */
export function hubViewsSender(hubUrl: string, token: string): (counts: Record<string, number>) => Promise<unknown> {
  const base = new URL(hubUrl)
  const client: ContractRouterClient<typeof contract> = createORPCClient(
    new RPCLink({
      origin: base.origin,
      url: `${base.pathname.replace(/\/+$/, '')}/rpc` as `/${string}`,
      headers: { authorization: `Bearer ${token}` },
    }),
  )
  return (counts) => client.wall.onlineViews({ counts })
}

/** Posts in one report at most: the hub's limit. */
const MAX_POSTS_PAR_ENVOI = 500
/** Views of one post in one report at most: the hub's limit. */
const MAX_VUES_PAR_POST = 100_000

/**
 * The views of the page's visitors, added up here and sent to the hub every half
 * minute: a crowd scrolling is one request to the hub, not one per phone.
 *
 * A failed send keeps its counts for the next one — the hub may be restarting.
 * A refused token drops them: they would be refused again until someone puts
 * the right one in the service's secret.
 */
export class ViewReporter {
  readonly #counts = new Map<string, number>()
  #timer: NodeJS.Timeout | null = null
  #lastError: string | null = null

  constructor(
    private readonly options: {
      send: (counts: Record<string, number>) => Promise<unknown>
      everyMs: number
      log: Log
    },
  ) {}

  add(ids: Iterable<string>, times = 1): void {
    for (const id of ids) {
      const held = this.#counts.get(id)
      if (held == null && this.#counts.size >= MAX_POSTS_PAR_ENVOI) continue
      this.#counts.set(id, Math.min(MAX_VUES_PAR_POST, (held ?? 0) + times))
    }
  }

  /** Views gathered and not sent yet. */
  get pending(): number {
    let total = 0
    for (const n of this.#counts.values()) total += n
    return total
  }

  /** Sends what is held. Never throws. */
  async flush(): Promise<void> {
    if (this.#counts.size === 0) return
    const counts = Object.fromEntries(this.#counts)
    this.#counts.clear()
    try {
      await this.options.send(counts)
      if (this.#lastError != null) this.options.log('info', 'vues en ligne : envoi au hub rétabli')
      this.#lastError = null
    } catch (cause) {
      const refused = (cause as { code?: unknown }).code === 'UNAUTHORIZED'
      if (!refused) for (const [id, n] of Object.entries(counts)) this.add([id], n)
      const message = cause instanceof Error ? cause.message : String(cause)
      if (message !== this.#lastError) {
        this.options.log('warn', refused ? 'vues en ligne refusées par le hub : jeton à refaire dans la console' : 'vues en ligne non envoyées, nouvel essai plus tard', { erreur: message })
      }
      this.#lastError = message
    }
  }

  start(): void {
    this.#timer = setInterval(() => void this.flush(), this.options.everyMs)
    this.#timer.unref()
  }

  stop(): void {
    if (this.#timer != null) clearInterval(this.#timer)
    this.#timer = null
  }
}

/**
 * The hub's wall, kept in memory.
 *
 * Asked every few seconds by this service alone, whatever the audience does: a
 * thousand phones on the page are a thousand reads of this memory, and still one
 * read of the hub. When the hub is out of reach the last state stays served —
 * the page goes on showing what it had, which is what the event's network will
 * need on the day.
 */
export class HubFeed {
  state: FeedState | null = null
  lastError: string | null = null
  #timer: NodeJS.Timeout | null = null
  #stopped = false

  constructor(
    private readonly options: {
      read: () => Promise<unknown>
      pollMs: number
      log: Log
      now?: () => number
    },
  ) {}

  /** One read. Never throws: a failed read keeps the state it had. */
  async refresh(): Promise<void> {
    try {
      // Checked rather than trusted: what is read here goes into a public page.
      const data = murPublicSchema.parse(await this.options.read())
      if (this.lastError != null) this.options.log('info', 'hub joint à nouveau', { revision: data.revision })
      this.lastError = null
      const now = this.options.now?.() ?? Date.now()
      if (this.state?.data.revision === data.revision) {
        this.state.receivedAt = now
        return
      }
      const json = JSON.stringify(data)
      this.state = {
        data,
        json,
        etag: `"${createHash('sha256').update(json).digest('base64url').slice(0, 22)}"`,
        images: imageKeys(data),
        postIds: new Set(data.posts.map((post) => post.id)),
        receivedAt: now,
      }
      this.options.log('info', 'mur reçu du hub', { revision: data.revision, posts: data.posts.length })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (message !== this.lastError) this.options.log('warn', 'hub injoignable : la page garde le dernier mur', { erreur: message })
      this.lastError = message
    }
  }

  start(): void {
    const tick = async () => {
      await this.refresh()
      if (this.#stopped) return
      this.#timer = setTimeout(tick, this.options.pollMs)
      this.#timer.unref()
    }
    void tick()
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer != null) clearTimeout(this.#timer)
  }
}

function imageKeys(data: MurPublic): Set<string> {
  const keys = new Set<string>()
  if (data.logo != null) keys.add(data.logo)
  for (const post of data.posts) {
    for (const key of [post.avatar, post.image, post.video, post.sponsor?.logo]) if (key != null) keys.add(key)
  }
  return keys
}

export interface Image {
  bytes: Buffer
  type: string
}

/**
 * The wall's images, fetched from the hub once and kept in memory, the oldest
 * dropped past the budget. Two visitors asking for the same image at the same
 * moment share one fetch.
 */
export class ImageCache {
  readonly #held = new Map<string, Image>()
  readonly #pending = new Map<string, Promise<Image | null>>()
  /**
   * Misses, until when: an image the hub does not hold (yet) is asked again
   * after `MISS_MS`, not on every visit — a crowd on the page would otherwise
   * turn one missing photo into as many requests to the hub.
   */
  readonly #misses = new Map<string, number>()
  #bytes = 0

  constructor(
    private readonly options: {
      hubUrl: string
      maxBytes: number
      fetchImpl?: typeof fetch
      now?: () => number
    },
  ) {}

  async get(key: string): Promise<Image | null> {
    const now = this.options.now?.() ?? Date.now()
    if ((this.#misses.get(key) ?? 0) > now) return null
    const held = this.#held.get(key)
    if (held != null) {
      // LRU: a Map iterates in insertion order, so re-inserting marks it most recent.
      this.#held.delete(key)
      this.#held.set(key, held)
      return held
    }
    const pending =
      this.#pending.get(key) ??
      this.fetch(key)
        .then((image) => {
          if (image == null) this.miss(key, now)
          else this.#misses.delete(key)
          return image
        })
        .finally(() => this.#pending.delete(key))
    this.#pending.set(key, pending)
    return pending
  }

  private miss(key: string, now: number): void {
    for (const [missed, until] of this.#misses) if (until <= now) this.#misses.delete(missed)
    this.#misses.set(key, now + MISS_MS)
  }

  private async fetch(key: string): Promise<Image | null> {
    const response = await (this.options.fetchImpl ?? fetch)(new URL(`assets/${key}`, withSlash(this.options.hubUrl)), {
      signal: AbortSignal.timeout(8_000),
    }).catch(() => null)
    if (response == null || !response.ok) return null
    const type = response.headers.get('content-type') ?? ''
    // The wall's short videos too (LinkedIn via walls.io): a few hundred kilobytes each.
    if (!type.startsWith('image/') && !/^video\/(mp4|webm)\b/.test(type)) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > MAX_IMAGE_BYTES) return null

    this.#held.set(key, { bytes, type })
    this.#bytes += bytes.byteLength
    for (const [oldest, image] of this.#held) {
      if (this.#bytes <= this.options.maxBytes) break
      this.#held.delete(oldest)
      this.#bytes -= image.bytes.byteLength
    }
    return { bytes, type }
  }
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MISS_MS = 30_000

function withSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}
