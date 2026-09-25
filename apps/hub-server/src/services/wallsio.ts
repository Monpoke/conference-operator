import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { WallsIoStatus } from '@conference-operator/contract'
import { hubSetting } from '@conference-operator/db/hub'
import type { HubDatabase } from '../db.js'
import type { SecretBox } from '../secrets.js'
import { htmlToText, type SocialSource } from './social.js'
import type { PostInput } from './wall.js'

const SETTING_KEY = 'wallsio'
const API = 'https://api.walls.io/v1'

/**
 * What the posts are asked for with: what the card draws, and what says whether
 * it still belongs on screen. Nothing more — the endpoint returns everything
 * otherwise, geolocation included.
 */
const FIELDS = [
  'id',
  'comment',
  'type',
  'external_name',
  'external_fullname',
  'external_image',
  'external_image_cdn',
  'post_image',
  'post_image_cdn',
  'is_pinned',
  'status',
  'permalink',
  'created_timestamp',
].join(',')

/**
 * The link's own state, apart from the hub settings.
 *
 * Apart because of the token: the settings travel whole to every console that
 * reads them, and this one must never come back. Sealed with the hub's secret
 * box, like the stream keys — a copy of `hub.db` does not hand over the wall's
 * moderation.
 */
const storedSchema = z.object({
  tokenSealed: z.string().nullable().default(null),
  tokenHint: z.string().nullable().default(null),
  /** walls.io's `current_time` from the last answer: the next `since`. */
  cursor: z.number().int().nullable().default(null),
  lastPollAt: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
})
type Stored = z.infer<typeof storedSchema>

export class WallsIoConfig {
  constructor(
    private readonly db: HubDatabase,
    private readonly box: SecretBox,
  ) {}

  /**
   * The token in clear, read at every poll: a token changed in the console
   * applies at the next one, with no restart. `null` when none is set — or when
   * the hub's secret changed and it can no longer be read, which the console
   * then shows as "no token" for someone to type it again.
   */
  token(): string | null {
    const sealed = this.read().tokenSealed
    return sealed == null ? null : this.box.open(sealed)
  }

  /** Sets or removes the token. Starts over from the latest posts: another wall, perhaps. */
  setToken(token: string | null): void {
    this.write({
      tokenSealed: token == null ? null : this.box.seal(token),
      tokenHint: token == null ? null : token.slice(-4),
      cursor: null,
      lastError: null,
    })
  }

  cursor(): number | null {
    return this.read().cursor
  }

  /** What a poll ended on: where to resume, and how it went. */
  record(outcome: { cursor?: number; error: string | null; at: string }): void {
    this.write({
      ...(outcome.cursor != null ? { cursor: outcome.cursor } : {}),
      lastPollAt: outcome.at,
      lastError: outcome.error,
    })
  }

  status(imported: number): WallsIoStatus {
    const stored = this.read()
    const readable = stored.tokenSealed != null && this.token() != null
    return {
      hasToken: readable,
      tokenHint: readable ? stored.tokenHint : null,
      lastPollAt: stored.lastPollAt,
      lastError: stored.lastError,
      imported,
    }
  }

  private read(): Stored {
    const row = this.db.select().from(hubSetting).where(eq(hubSetting.key, SETTING_KEY)).get()
    if (row == null) return storedSchema.parse({})
    const parsed = storedSchema.safeParse(JSON.parse(row.valueJson))
    return parsed.success ? parsed.data : storedSchema.parse({})
  }

  private write(patch: Partial<Stored>): void {
    const valueJson = JSON.stringify({ ...this.read(), ...patch })
    const updatedAt = new Date().toISOString()
    this.db
      .insert(hubSetting)
      .values({ key: SETTING_KEY, valueJson, updatedAt })
      .onConflictDoUpdate({ target: hubSetting.key, set: { valueJson, updatedAt } })
      .run()
  }
}

const postSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  comment: z.string().nullish(),
  type: z.string().nullish(),
  external_name: z.string().nullish(),
  external_fullname: z.string().nullish(),
  external_image: z.string().nullish(),
  external_image_cdn: z.string().nullish(),
  post_image: z.string().nullish(),
  post_image_cdn: z.string().nullish(),
  is_pinned: z.boolean().nullish(),
  status: z.boolean().nullish(),
  permalink: z.string().nullish(),
  created_timestamp: z.number().nullish(),
})

const responseSchema = z.looseObject({
  status: z.string().optional(),
  current_time: z.number().int().optional(),
  data: z.array(postSchema).default([]),
})

/** The first poll after a token is set: the latest posts, not the wall's history. */
const BOOTSTRAP_LIMIT = 100
/** `/posts/changed` answers at most this many; beyond, we would have missed some. */
const CHANGED_LIMIT = 1000

/**
 * walls.io, through its API.
 *
 * The first poll takes the wall's latest active posts; every later one asks what
 * changed since the previous answer (`/posts/changed`) — new posts, and the old
 * ones deactivated, reactivated, pinned. That is how a post hidden by the
 * walls.io moderator leaves the rooms' screens, without the hub moderating it a
 * second time.
 *
 * No token = no call: the source is always there, and wakes up the moment one is
 * typed in the console.
 */
export function wallsioSource(options: {
  config: WallsIoConfig
  fetchImpl?: typeof fetch
  now?: () => number
  onLog?: (level: 'debug' | 'info', message: string, context?: object) => void
}): SocialSource {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now

  async function call(path: string, params: Record<string, string>, token: string) {
    const url = new URL(`${API}${path}`)
    url.searchParams.set('access_token', token)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) })
    if (response.status === 401 || response.status === 403) {
      throw new Error('jeton walls.io refusé : vérifiez-le dans les réglages')
    }
    if (!response.ok) throw new Error(`walls.io a répondu ${response.status}`)
    return responseSchema.parse(await response.json())
  }

  return {
    id: 'wallsio',
    async poll() {
      const token = options.config.token()
      if (token == null) return []
      const at = new Date(now()).toISOString()
      try {
        const cursor = options.config.cursor()
        let posts: z.infer<typeof postSchema>[]
        let next: number
        if (cursor == null) {
          const body = await call('/posts', { fields: FIELDS, limit: String(BOOTSTRAP_LIMIT) }, token)
          posts = body.data
          options.onLog?.('info', `walls.io : premiers posts lus (${posts.length})`, { endpoint: '/posts', recus: posts.length })
          // `/posts` gives no server time: our clock, a little early — a post
          // seen twice is deduplicated, a post missed is lost.
          next = Math.floor(now() / 1000) - 120
        } else {
          const body = await call(
            '/posts/changed',
            { since: String(cursor), fields: FIELDS, include_inactive: '1', limit: String(CHANGED_LIMIT) },
            token,
          )
          posts = body.data
          next = body.current_time ?? Math.floor(now() / 1000) - 120
          options.onLog?.('debug', 'walls.io : changements lus', {
            endpoint: '/posts/changed',
            depuis: new Date(cursor * 1000).toISOString(),
            recus: posts.length,
          })
          if (posts.length >= CHANGED_LIMIT) {
            options.onLog?.('info', `walls.io : ${CHANGED_LIMIT} changements d'un coup, des posts ont pu être manqués`)
          }
        }
        options.config.record({ cursor: next, error: null, at })
        return posts.map(toPostInput).filter((post): post is PostInput => post != null)
      } catch (cause) {
        options.config.record({ error: (cause as Error).message, at })
        throw cause
      }
    },
  }
}

function toPostInput(post: z.infer<typeof postSchema>): PostInput | null {
  const text = htmlToText(post.comment ?? '')
  const image = post.post_image_cdn || post.post_image || null
  // Nothing to draw: a card with neither words nor picture.
  if (text.length === 0 && image == null) return null
  const handle = post.external_name?.trim() || null
  return {
    source: 'wallsio',
    externalId: post.id,
    author: post.external_fullname?.trim() || handle || 'walls.io',
    authorHandle: handle,
    text,
    avatar: post.external_image_cdn || post.external_image || null,
    image,
    permalink: post.permalink ?? null,
    network: networkName(post.type),
    postedAt: post.created_timestamp != null ? new Date(post.created_timestamp * 1000).toISOString() : null,
    active: post.status ?? true,
    pinned: post.is_pinned ?? false,
  }
}

const NETWORKS: Record<string, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  twitter: 'X',
  x: 'X',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  mastodon: 'Mastodon',
  bluesky: 'Bluesky',
  threads: 'Threads',
  flickr: 'Flickr',
  rss: 'RSS',
}

/** walls.io's `type`, as the card's foot names it. */
function networkName(type: string | null | undefined): string | null {
  if (type == null || type === '') return null
  const key = type.toLowerCase()
  return NETWORKS[key] ?? key.charAt(0).toUpperCase() + key.slice(1)
}
