import { desc, eq, sql, sum } from 'drizzle-orm'
import { z } from 'zod'
import {
  WALL_STATS_TOP,
  type WallStats,
  type WallStatsCount,
  type WallStatsTopPost,
  type WallsIoStats,
} from '@conference-operator/contract'
import { comment, commentImpression, commentOnlineView } from '@conference-operator/db/hub'
import type { HubDatabase } from '../db.js'
import { API, networkName, type WallsIoConfig } from './wallsio.js'

/** walls.io's figures are read again after this long, not on every visit. */
export const WALLSIO_STATS_TTL_MS = 5 * 60_000
const WALLSIO_TIMEOUT_MS = 8_000
const SAMPLE_LIMIT = 1000
const SHORT_TEXT = 120

/** `{status, data: {instagram: 12, total: 20}}`, from `/analytics/posts` and `/analytics/users`. */
const analyticsSchema = z.looseObject({
  data: z.record(z.string(), z.number()),
})

const sampleSchema = z.looseObject({
  data: z
    .array(
      z.looseObject({
        sentiment: z.union([z.string(), z.number()]).nullish(),
        language: z.string().nullish(),
      }),
    )
    .default([]),
})

const PARIS_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/**
 * The social wall in figures, for the console.
 *
 * The hub's part is read from its own tables at every call: a handful of
 * operators ask, never the audience. walls.io's part goes out to its API, kept
 * five minutes; it never fails the answer — no token, paused, an error, and it
 * comes back `null` with why.
 */
export class WallStatsService {
  private cached: { token: string; at: number; stats: WallsIoStats } | null = null
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(
    private readonly options: {
      db: HubDatabase
      config: WallsIoConfig
      fetchImpl?: typeof fetch
      now?: () => number
    },
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
  }

  async stats(): Promise<WallStats> {
    const local = this.local()
    const remote = await this.wallsio()
    return { generatedAt: new Date(this.now()).toISOString(), ...local, ...remote }
  }

  private local(): Pick<WallStats, 'posts' | 'impressions' | 'onlineViews'> {
    const db = this.options.db
    const rows = db
      .select({
        network: comment.network,
        source: comment.source,
        video: comment.video,
        image: comment.image,
        publishedAt: sql<string>`coalesce(${comment.postedAt}, ${comment.createdAt})`,
      })
      .from(comment)
      .where(eq(comment.status, 'approved'))
      .all()

    const networks = new Map<string, number>()
    const days = new Map<string, number>()
    const byMedia = { video: 0, photo: 0, text: 0 }
    for (const row of rows) {
      const network = row.network ?? row.source
      networks.set(network, (networks.get(network) ?? 0) + 1)
      const at = Date.parse(row.publishedAt)
      if (Number.isFinite(at)) {
        const day = PARIS_DAY.format(at)
        days.set(day, (days.get(day) ?? 0) + 1)
      }
      if (row.video != null) byMedia.video += 1
      else if (row.image != null) byMedia.photo += 1
      else byMedia.text += 1
    }

    const impressionsTotal =
      db.select({ n: sum(commentImpression.count).mapWith(Number) }).from(commentImpression).get()?.n ?? 0
    const onlineTotal =
      db.select({ n: sum(commentOnlineView.count).mapWith(Number) }).from(commentOnlineView).get()?.n ?? 0

    const impressionsTop = db
      .select({
        id: comment.id,
        author: comment.author,
        network: comment.network,
        text: comment.text,
        count: sum(commentImpression.count).mapWith(Number),
      })
      .from(commentImpression)
      .innerJoin(comment, eq(comment.id, commentImpression.commentId))
      .groupBy(comment.id)
      .orderBy(desc(sum(commentImpression.count)), comment.id)
      .limit(WALL_STATS_TOP)
      .all()
    const onlineTop = db
      .select({
        id: comment.id,
        author: comment.author,
        network: comment.network,
        text: comment.text,
        count: sum(commentOnlineView.count).mapWith(Number),
      })
      .from(commentOnlineView)
      .innerJoin(comment, eq(comment.id, commentOnlineView.commentId))
      .groupBy(comment.id)
      .orderBy(desc(sum(commentOnlineView.count)), comment.id)
      .limit(WALL_STATS_TOP)
      .all()

    return {
      posts: {
        total: rows.length,
        byNetwork: sorted(networks),
        byDay: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count })),
        byMedia,
      },
      impressions: { total: impressionsTotal, top: impressionsTop.map(topPost) },
      onlineViews: { total: onlineTotal, top: onlineTop.map(topPost) },
    }
  }

  private async wallsio(): Promise<Pick<WallStats, 'wallsio' | 'wallsioError'>> {
    const token = this.options.config.token()
    if (token == null) return { wallsio: null, wallsioError: 'Aucun jeton walls.io : à régler dans Réglages.' }
    if (this.options.config.paused()) {
      return { wallsio: null, wallsioError: 'Lecture walls.io en pause : ses chiffres ne sont pas lus.' }
    }
    const cached = this.cached
    if (cached != null && cached.token === token && this.now() - cached.at < WALLSIO_STATS_TTL_MS) {
      return { wallsio: cached.stats, wallsioError: null }
    }
    try {
      const [posts, users, sample] = await Promise.all([
        this.call('/analytics/posts', {}, token).then((body) => analyticsSchema.parse(body)),
        this.call('/analytics/users', {}, token).then((body) => analyticsSchema.parse(body)),
        this.call('/posts', { limit: String(SAMPLE_LIMIT), fields: 'id,sentiment,language' }, token).then((body) =>
          sampleSchema.parse(body),
        ),
      ])
      const sentiment = { positive: 0, neutral: 0, negative: 0, unknown: 0 }
      const languages = new Map<string, number>()
      for (const post of sample.data) {
        sentiment[sentimentOf(post.sentiment)] += 1
        const language = post.language?.trim().toLowerCase() || 'non détectée'
        languages.set(language, (languages.get(language) ?? 0) + 1)
      }
      const stats: WallsIoStats = {
        fetchedAt: new Date(this.now()).toISOString(),
        posts: perNetwork(posts.data),
        authors: perNetwork(users.data),
        sentiment,
        languages: sorted(languages),
        sampled: sample.data.length,
      }
      this.cached = { token, at: this.now(), stats }
      return { wallsio: stats, wallsioError: null }
    } catch (cause) {
      return { wallsio: null, wallsioError: readable(cause) }
    }
  }

  private async call(path: string, params: Record<string, string>, token: string): Promise<unknown> {
    const url = new URL(`${API}${path}`)
    url.searchParams.set('access_token', token)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(WALLSIO_TIMEOUT_MS) })
    if (response.status === 401 || response.status === 403) {
      throw new Error('jeton walls.io refusé : vérifiez-le dans les réglages')
    }
    if (!response.ok) throw new Error(`walls.io a répondu ${response.status}`)
    return response.json()
  }
}

function sorted(counts: Map<string, number>): WallStatsCount[] {
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/** walls.io's `{instagram: 12, total: 20}`: the networks named, the total apart. */
function perNetwork(data: Record<string, number>): { total: number; byNetwork: WallStatsCount[] } {
  const networks = new Map<string, number>()
  let summed = 0
  for (const [key, value] of Object.entries(data)) {
    if (key === 'total' || !Number.isFinite(value) || value <= 0) continue
    const label = networkName(key) ?? key
    const count = Math.round(value)
    networks.set(label, (networks.get(label) ?? 0) + count)
    summed += count
  }
  const total = data.total
  return { total: Number.isFinite(total) && total! >= 0 ? Math.round(total!) : summed, byNetwork: sorted(networks) }
}

function sentimentOf(value: string | number | null | undefined): 'positive' | 'neutral' | 'negative' | 'unknown' {
  if (typeof value === 'number') return value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral'
  const word = value?.trim().toLowerCase()
  if (word === 'positive' || word === 'neutral' || word === 'negative') return word
  return 'unknown'
}

function topPost(row: { id: string; author: string; network: string | null; text: string; count: number | null }): WallStatsTopPost {
  const text = row.text.replace(/\s+/g, ' ').trim()
  return {
    id: row.id,
    author: row.author,
    network: row.network,
    text: text.length > SHORT_TEXT ? `${text.slice(0, SHORT_TEXT - 1)}…` : text,
    count: row.count ?? 0,
  }
}

function readable(cause: unknown): string {
  const error = cause as { name?: string; message?: string }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return "walls.io n'a pas répondu à temps"
  if (cause instanceof z.ZodError) return 'réponse de walls.io illisible'
  if (cause instanceof TypeError) return `walls.io injoignable : ${error.message}`
  return error?.message ? `walls.io : ${error.message.replace(/^walls\.io\s*:?\s*/i, '')}` : 'walls.io injoignable'
}
