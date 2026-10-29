import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  MUR_PUBLIC_TOKEN_PREFIX,
  type Comment,
  type MurPublic,
  type MurPublicAccess,
  type PublicPost,
} from '@conference-operator/contract'
import { hubSetting } from '@conference-operator/db/hub'
import type { HubDatabase } from '../db.js'
import { DEFAULT_THEME } from '@conference-operator/projector/server'
import type { AssetStore } from './assets.js'
import type { EventIdentityService } from './event-identity.js'
import { RateLimiter } from './rate-limit.js'
import type { SettingsService } from './sessions.js'
import type { ThemeStore } from './themes.js'
import { safePermalink, type WallService } from './wall.js'

/**
 * What the public social page (`apps/mur-public`) is given: the wall the rooms
 * project, with the active theme's colours and the hashtag to post with.
 *
 * Rebuilt only when one of its inputs moves — the wall's revision, the theme,
 * the event's name — and served from memory otherwise: the service asks every
 * few seconds, and must cost the hub nothing while the day goes on.
 */
export class MurPublicService {
  /**
   * Its own bucket, apart from the posting form's: the service polls from one
   * address, and a few reads by hand must not use up the audience's posts.
   */
  readonly limiter = new RateLimiter({ capacity: 30, refillPerSecond: 1 })
  #cached: { key: string; value: MurPublic } | null = null

  constructor(
    private readonly deps: {
      wall: WallService
      assets: AssetStore
      themes: ThemeStore
      settings: SettingsService
      identity: EventIdentityService
    },
  ) {}

  current(): MurPublic {
    const screen = this.deps.wall.screen()
    const boucle = this.deps.settings.get().boucle
    const chosen = boucle.theme
    // Held, or nothing: an image the hub has not downloaded yet waits for it.
    const logo = this.held(boucle.logo)
    const event = { name: this.deps.identity.get().name }
    // The social wall's own, set in the console (Boucle → Mur social) and the
    // loop's `boucle.json`: the one the rooms show above the posts. Its first
    // word only — it is display text, and a share link needs a hashtag.
    const hashtag = /^#?([\p{L}\p{N}_]+)/u.exec(boucle.wallsio.hashtag.trim())?.[1] ?? null
    const accroche = boucle.wallsio.accroche.trim()
    const menu = boucle.wallsio.menu
    const reseaux = boucle.wallsio.reseaux
    // The images held too: a post published before its photo was downloaded is drawn again once it is in.
    const key = JSON.stringify([screen.revision, chosen?.sha ?? null, event.name, hashtag, logo, accroche, menu, reseaux, this.deps.assets.generation])
    if (this.#cached?.key === key) return this.#cached.value

    const manifest = (chosen == null ? null : this.deps.themes.load(chosen.sha)?.bundle.manifest) ?? null
    const base = DEFAULT_THEME.manifest
    const value: MurPublic = {
      revision: createHash('sha256').update(key).digest('hex').slice(0, 16),
      event,
      logo,
      hashtag,
      accroche,
      menu,
      reseaux,
      theme: {
        couleurs: { ...base.couleurs, ...manifest?.couleurs },
        fond: manifest?.fond ?? base.fond ?? null,
        polices: { ...base.polices.roles, ...manifest?.polices.roles },
      },
      posts: screen.posts.map((post) => this.toPublic(post)),
    }
    this.#cached = { key, value }
    return value
  }

  private toPublic(post: Comment): PublicPost {
    return {
      id: post.id,
      author: post.author,
      authorSubtitle: post.authorSubtitle,
      avatar: this.held(post.avatar),
      text: post.text,
      image: this.held(post.image),
      video: this.held(post.video),
      network: post.network ?? NETWORK_BY_SOURCE[post.source] ?? null,
      postedAt: post.postedAt ?? post.createdAt,
      permalink: safePermalink(post.permalink),
      featured: post.featured,
      sponsor: post.sponsor == null ? null : { name: post.sponsor.name, logo: this.held(post.sponsor.logo) },
    }
  }

  /** The hub's key for an image it holds; a remote address never leaves. */
  private held(ref: string | null): string | null {
    return ref != null && this.deps.assets.has(ref) ? this.deps.assets.keyOf(ref) : null
  }
}

const ACCESS_KEY = 'murPublic'

const accessSchema = z.object({
  tokenHash: z.string().nullable().default(null),
  tokenHint: z.string().nullable().default(null),
  lastReportAt: z.string().nullable().default(null),
})
type StoredAccess = z.infer<typeof accessSchema>

/**
 * The `mur-public` service's token: what lets it report the views of the public
 * page.
 *
 * Created in the console and shown there once; the hub keeps only its hash — it
 * never has to send it anywhere, only to recognise it. A new one replaces the
 * old, which stops working at once.
 */
export class MurPublicAccessService {
  constructor(private readonly db: HubDatabase) {}

  /** A new token, in clear: the only time it exists outside the service's secret. */
  create(): string {
    const token = `${MUR_PUBLIC_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    this.write({ tokenHash: hashToken(token), tokenHint: token.slice(-4) })
    return token
  }

  remove(): void {
    this.write({ tokenHash: null, tokenHint: null })
  }

  /** Whether this is the current token. Compared as hashes, in constant time. */
  verify(token: string | null): boolean {
    const stored = this.read().tokenHash
    if (token == null || stored == null || !token.startsWith(MUR_PUBLIC_TOKEN_PREFIX)) return false
    return timingSafeEqual(Buffer.from(hashToken(token), 'hex'), Buffer.from(stored, 'hex'))
  }

  /** The service reported: the console shows it is alive. */
  reported(at: string): void {
    this.write({ lastReportAt: at })
  }

  status(): MurPublicAccess {
    const stored = this.read()
    return { hasToken: stored.tokenHash != null, tokenHint: stored.tokenHint, lastReportAt: stored.lastReportAt }
  }

  private read(): StoredAccess {
    const row = this.db.select().from(hubSetting).where(eq(hubSetting.key, ACCESS_KEY)).get()
    if (row == null) return accessSchema.parse({})
    const parsed = accessSchema.safeParse(JSON.parse(row.valueJson))
    return parsed.success ? parsed.data : accessSchema.parse({})
  }

  private write(patch: Partial<StoredAccess>): void {
    const valueJson = JSON.stringify({ ...this.read(), ...patch })
    const updatedAt = new Date().toISOString()
    this.db
      .insert(hubSetting)
      .values({ key: ACCESS_KEY, valueJson, updatedAt })
      .onConflictDoUpdate({ target: hubSetting.key, set: { valueJson, updatedAt } })
      .run()
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** The room card's wording (`buildWallCards`), for the posts that do not name their network. */
const NETWORK_BY_SOURCE: Partial<Record<Comment['source'], string>> = {
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  x: 'X',
  form: 'Sur place',
}
