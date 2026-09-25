import { z } from 'zod'
import { isoDateTimeSchema, roomIdSchema, sessionIdSchema } from './primitives.js'
import { imageRefSchema } from './boucle.js'

/**
 * Where a message comes from.
 *
 * Every source converges on the same wall. `wallsio` is the one exception to the
 * moderation queue — walls.io moderates upstream, its posts arrive approved —
 * and `hub` is written in the console itself: the partner posts and the posts
 * that used to be typed by hand in the loop settings.
 */
export const commentSourceSchema = z.enum(['form', 'bluesky', 'mastodon', 'x', 'wallsio', 'hub'])
export type CommentSource = z.infer<typeof commentSourceSchema>

/** The partner behind a post written in the hub: « Partenaire » on screen. */
export const wallSponsorSchema = z.object({
  name: z.string().trim().min(1).max(80),
  logo: imageRefSchema.nullable().default(null),
})
export type WallSponsor = z.infer<typeof wallSponsorSchema>

export const moderationStatusSchema = z.enum(['pending', 'approved', 'rejected'])

export const commentSchema = z.object({
  id: z.string(),
  source: commentSourceSchema,
  author: z.string().max(80),
  /** Origin handle for social sources, `null` for the form. */
  authorHandle: z.string().nullable(),
  /** 500 through the public form; up to 1500 for the social posts and the hub's. */
  text: z.string().max(1500),
  status: moderationStatusSchema,
  roomId: roomIdSchema.nullable(),
  sessionId: sessionIdSchema.nullable(),
  createdAt: isoDateTimeSchema,
  // What the social wall draws. Defaulted: a hub from before them still parses.
  /** The line under the name (a job title on LinkedIn). */
  authorSubtitle: z.string().max(120).nullable().default(null),
  avatar: imageRefSchema.nullable().default(null),
  image: imageRefSchema.nullable().default(null),
  permalink: z.string().max(600).nullable().default(null),
  /** The network named at the foot of the card: "Instagram", "LinkedIn"… */
  network: z.string().max(30).nullable().default(null),
  /** When it was posted at the source; `null` = `createdAt`. */
  postedAt: isoDateTimeSchema.nullable().default(null),
  /** Always on the page, in a larger card: put forward, pinned on walls.io, or a partner's. */
  featured: z.boolean().default(false),
  /** Pinned on walls.io: featured whatever the console says — unpinned there, or hidden here. */
  pinned: z.boolean().default(false),
  sponsor: wallSponsorSchema.nullable().default(null),
})
export type Comment = z.infer<typeof commentSchema>

/**
 * What the rooms hold of the wall: the posts on screen, featured first.
 *
 * `revision` changes with anything that changes the screen — a post in, a post
 * hidden, put forward — so that a room asks for it only when it moved.
 */
export const wallSnapshotSchema = z.object({
  revision: z.string(),
  posts: z.array(commentSchema),
})
export type WallSnapshot = z.infer<typeof wallSnapshotSchema>

/**
 * A post as the room screen draws it: images localised (`/assets/…`) or `null`,
 * never a remote address — the loop's page has no origin but the room's.
 */
export interface WallCard {
  id: string
  source: CommentSource
  author: string
  authorSubtitle: string | null
  /** `null` = the author's initials on a tint. */
  avatarUrl: string | null
  text: string
  imageUrl: string | null
  /** The network at the foot of the card; `null` = none named. */
  network: string | null
  /** When it was posted, for "25 min". */
  postedAt: string
  featured: boolean
  sponsor: { name: string; logoUrl: string | null } | null
}

/** A post written in the console. `id` absent = a new one. */
export const hubPostInputSchema = z.object({
  id: z.string().optional(),
  author: z.string().trim().min(1).max(80),
  authorSubtitle: z.string().trim().max(120).nullable().default(null),
  avatar: imageRefSchema.nullable().default(null),
  text: z.string().trim().max(1500).default(''),
  image: imageRefSchema.nullable().default(null),
  network: z.string().trim().max(30).nullable().default(null),
  permalink: z.url().nullable().default(null),
  sponsor: wallSponsorSchema.nullable().default(null),
  featured: z.boolean().default(true),
})
export type HubPostInput = z.input<typeof hubPostInputSchema>

/**
 * The walls.io link as the console sees it.
 *
 * The token never comes back — only its last four characters, enough to
 * recognise it: it gives read access to the wall *and* its moderation.
 */
export const wallsIoStatusSchema = z.object({
  hasToken: z.boolean(),
  tokenHint: z.string().nullable(),
  lastPollAt: isoDateTimeSchema.nullable(),
  lastError: z.string().nullable(),
  /** Posts from walls.io currently on the wall. */
  imported: z.number().int().nonnegative(),
})
export type WallsIoStatus = z.infer<typeof wallsIoStatusSchema>

export const questionSchema = z.object({
  id: z.string(),
  roomId: roomIdSchema,
  sessionId: sessionIdSchema.nullable(),
  author: z.string().max(80).nullable(),
  text: z.string().max(300),
  votes: z.number().int().nonnegative(),
  status: z.enum(['open', 'asked', 'answered']),
  createdAt: isoDateTimeSchema,
})
export type Question = z.infer<typeof questionSchema>
