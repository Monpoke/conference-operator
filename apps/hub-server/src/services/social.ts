import { z } from 'zod'
import type { CommentSource } from '@cloudnord/contract'
import type { PostInput, WallService } from './wall.js'

/**
 * Une source sociale.
 *
 * Toutes convergent vers la même file de modération : ce qui vient de Bluesky
 * n'a pas plus de droits qu'un message déposé au formulaire.
 */
export interface SocialSource {
  readonly id: CommentSource
  /** Messages récents. Ne lève pas : une source en panne ne doit pas arrêter les autres. */
  poll(): Promise<PostInput[]>
}

const blueskyResponseSchema = z.object({
  posts: z
    .array(
      z.object({
        uri: z.string(),
        author: z.object({ handle: z.string(), displayName: z.string().nullish() }),
        record: z.looseObject({ text: z.string().nullish() }),
      }),
    )
    .default([]),
})

/**
 * Bluesky, via l'AppView publique.
 *
 * Pas de clé, pas de compte : l'endpoint de recherche public suffit, ce qui
 * évite d'avoir à gérer un secret de plus le jour J.
 */
export function blueskySource(options: {
  hashtag: string
  fetchImpl?: typeof fetch
  limit?: number
  endpoint?: string
}): SocialSource {
  const fetchImpl = options.fetchImpl ?? fetch
  const endpoint = options.endpoint ?? 'https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts'

  return {
    id: 'bluesky',
    async poll() {
      const url = new URL(endpoint)
      url.searchParams.set('q', `#${options.hashtag}`)
      url.searchParams.set('limit', String(options.limit ?? 25))
      url.searchParams.set('sort', 'latest')

      const response = await fetchImpl(url, { signal: AbortSignal.timeout(8_000) })
      if (!response.ok) throw new Error(`Bluesky a répondu ${response.status}`)

      const parsed = blueskyResponseSchema.parse(await response.json())
      return parsed.posts
        .filter((post) => typeof post.record.text === 'string' && post.record.text.trim().length > 0)
        .map((post) => ({
          source: 'bluesky' as const,
          author: post.author.displayName?.trim() || post.author.handle,
          authorHandle: post.author.handle,
          text: String(post.record.text),
          // L'URI du post : stable, et c'est elle qui déduplique les relivraisons.
          externalId: post.uri,
        }))
    },
  }
}

const mastodonStatusSchema = z.array(
  z.looseObject({
    id: z.string(),
    content: z.string(),
    account: z.looseObject({ acct: z.string(), display_name: z.string().nullish() }),
  }),
)

/**
 * Mastodon, via la timeline publique d'un hashtag.
 *
 * L'API renvoie du HTML : on le réduit en texte, parce qu'un mur de salle
 * affiche du texte et qu'injecter du HTML tiers sur un vidéoprojecteur est une
 * mauvaise idée par principe.
 */
export function mastodonSource(options: {
  instance: string
  hashtag: string
  fetchImpl?: typeof fetch
  limit?: number
}): SocialSource {
  const fetchImpl = options.fetchImpl ?? fetch

  return {
    id: 'mastodon',
    async poll() {
      const url = new URL(`/api/v1/timelines/tag/${encodeURIComponent(options.hashtag)}`, options.instance)
      url.searchParams.set('limit', String(options.limit ?? 25))

      const response = await fetchImpl(url, { signal: AbortSignal.timeout(8_000) })
      if (!response.ok) throw new Error(`Mastodon a répondu ${response.status}`)

      return mastodonStatusSchema
        .parse(await response.json())
        .map((status) => ({
          source: 'mastodon' as const,
          author: status.account.display_name?.trim() || status.account.acct,
          authorHandle: status.account.acct,
          text: htmlToText(status.content),
          externalId: status.id,
        }))
        .filter((entry) => entry.text.length > 0)
    },
  }
}

/**
 * X / Twitter.
 *
 * **Nécessite un plan payant** : la recherche par hashtag n'est plus accessible
 * au niveau gratuit. L'adapter existe pour que le jour où le budget est validé
 * il n'y ait qu'une clé à poser — et il échoue avec un message explicite plutôt
 * que de laisser croire à une panne.
 */
export function xSource(options: {
  hashtag: string
  bearerToken: string | null
  fetchImpl?: typeof fetch
}): SocialSource {
  const fetchImpl = options.fetchImpl ?? fetch

  return {
    id: 'x',
    async poll() {
      if (options.bearerToken == null) {
        throw new Error(
          "Source X désactivée : aucune clé configurée (l'API de recherche nécessite un plan payant)",
        )
      }
      const url = new URL('https://api.x.com/2/tweets/search/recent')
      url.searchParams.set('query', `#${options.hashtag} -is:retweet`)
      url.searchParams.set('tweet.fields', 'author_id')
      url.searchParams.set('expansions', 'author_id')

      const response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${options.bearerToken}` },
        signal: AbortSignal.timeout(8_000),
      })
      if (!response.ok) throw new Error(`X a répondu ${response.status}`)

      const body = (await response.json()) as {
        data?: { id: string; text: string; author_id: string }[]
        includes?: { users?: { id: string; username: string; name: string }[] }
      }
      const users = new Map((body.includes?.users ?? []).map((user) => [user.id, user]))

      return (body.data ?? []).map((tweet) => {
        const user = users.get(tweet.author_id)
        return {
          source: 'x' as const,
          author: user?.name ?? user?.username ?? 'inconnu',
          authorHandle: user?.username ?? null,
          text: tweet.text,
          externalId: tweet.id,
        }
      })
    },
  }
}

export interface IngestorReport {
  bySource: Record<string, { collected: number; error: string | null }>
}

/**
 * Interroge les sources et dépose dans la file de modération.
 *
 * Les sources sont interrogées **séquentiellement et hors transaction** : un
 * appel réseau dans une transaction SQLite bloquerait la base le temps d'un
 * timeout HTTP, et c'est le piège classique avec ce genre d'ingestion.
 */
export class SocialIngestor {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly sources: SocialSource[],
    private readonly wall: WallService,
    private readonly options: {
      intervalMs?: number
      onLog?: (level: 'info' | 'warn', message: string, context?: unknown) => void
    } = {},
  ) {}

  async runOnce(): Promise<IngestorReport> {
    const report: IngestorReport = { bySource: {} }

    for (const source of this.sources) {
      try {
        const posts = await source.poll()
        // Le dépôt est idempotent sur `externalId` : relire la même fenêtre est
        // sans conséquence, ce qui autorise un recouvrement généreux.
        for (const post of posts) this.wall.post(post)
        report.bySource[source.id] = { collected: posts.length, error: null }
      } catch (cause) {
        const message = (cause as Error).message
        report.bySource[source.id] = { collected: 0, error: message }
        this.options.onLog?.('warn', `source ${source.id} indisponible`, { message })
      }
    }
    return report
  }

  start(): void {
    if (this.timer != null) return
    this.timer = setInterval(() => {
      if (this.running) return
      this.running = true
      void this.runOnce().finally(() => {
        this.running = false
      })
    }, this.options.intervalMs ?? 30_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer != null) clearInterval(this.timer)
    this.timer = null
  }
}

/** Réduit le HTML de Mastodon en texte affichable. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
