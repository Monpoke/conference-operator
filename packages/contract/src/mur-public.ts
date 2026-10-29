import { z } from 'zod'
import { isoDateTimeSchema } from './primitives.js'
import { couleurThemeSchema, valeurCssSchema } from './theme.js'
import { wallImpressionCountsSchema } from './wall.js'
import { menuLinkSchema, reseauPartageSchema } from './boucle.js'

/**
 * The public social page: what the hub hands to the `mur-public` service.
 *
 * That service is the one exposed on its own domain (social.<event>.fr), to an
 * audience without an account; the hub is only ever asked by it. So everything
 * here is already public — the posts shown in large type in the rooms — and
 * nothing else: no handle the room screens do not show, no moderation state.
 */

/** An image the hub holds, by its key: `/assets/<key>`. Never a remote address. */
export const assetKeySchema = z.string().regex(/^[0-9a-f]{64}$/, 'clé d’image du hub attendue')

export const publicPostSchema = z.object({
  id: z.string(),
  author: z.string().max(80),
  authorSubtitle: z.string().max(120).nullable(),
  /** `null`: the hub does not hold it (yet) — the page draws the initials. */
  avatar: assetKeySchema.nullable(),
  text: z.string().max(1500),
  image: assetKeySchema.nullable(),
  /** A short looping video, `image` its still. `null`: none, or the hub does not hold it (yet). */
  video: assetKeySchema.nullable().default(null),
  /** The network at the foot of the card: "Instagram", "Bluesky"… */
  network: z.string().max(30).nullable(),
  postedAt: isoDateTimeSchema,
  /** The post at its source, `http(s)` only (`safePermalink`). */
  permalink: z.string().max(600).nullable(),
  featured: z.boolean(),
  sponsor: z.object({ name: z.string().max(80), logo: assetKeySchema.nullable() }).nullable(),
})
export type PublicPost = z.infer<typeof publicPostSchema>

export const murPublicSchema = z.object({
  /** Changes with the posts, the theme or the event's name: the page's ETag. */
  revision: z.string(),
  event: z.object({ name: z.string().max(120) }),
  /** The loop's logo (`boucle.logo`), held by the hub: the page's favicon. `null`: none, or not downloaded yet. */
  logo: assetKeySchema.nullable().default(null),
  /** The social wall's (`boucle.wallsio.hashtag`), without `#`. `null`: none set, the page offers no button to post. */
  hashtag: z.string().max(60).nullable(),
  /** The line under the hashtag, as the console sets it (`boucle.wallsio.accroche`); `{hashtag}` left for the page. Empty: the page's own. */
  accroche: z.string().max(240).default(''),
  /** The event site's links, as the console sets them (`boucle.wallsio.menu`). Empty: no menu. */
  menu: z.array(menuLinkSchema).max(12).default([]),
  /** The « Publier sur … » buttons ticked in the console (`boucle.wallsio.reseaux`). */
  reseaux: z.array(reseauPartageSchema).max(4).default(['bluesky', 'mastodon', 'x', 'linkedin']),
  /** The active theme's colours, over the default theme's: every token is set. */
  theme: z.object({
    couleurs: z.record(z.string(), couleurThemeSchema),
    fond: valeurCssSchema.nullable(),
    polices: z.record(z.string(), valeurCssSchema),
  }),
  posts: z.array(publicPostSchema),
})
export type MurPublic = z.infer<typeof murPublicSchema>

/** The `mur-public` service's token: recognised by its prefix, like the rooms' and the workers'. */
export const MUR_PUBLIC_TOKEN_PREFIX = 'mp_'

/**
 * What the public page's visitors saw: post id → times a card stayed in view.
 * Sent by the `mur-public` service with its token, every half minute.
 */
export const onlineViewsInputSchema = z.object({ counts: wallImpressionCountsSchema })
export type OnlineViewsInput = z.infer<typeof onlineViewsInputSchema>

/**
 * The service's token as the console sees it: whether there is one, its last
 * characters, and when the service last reported. The token itself is shown once,
 * when it is created, and the hub keeps only its hash.
 */
export const murPublicAccessSchema = z.object({
  hasToken: z.boolean(),
  tokenHint: z.string().nullable(),
  lastReportAt: isoDateTimeSchema.nullable(),
})
export type MurPublicAccess = z.infer<typeof murPublicAccessSchema>
