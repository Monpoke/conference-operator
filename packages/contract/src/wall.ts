import { z } from 'zod'
import { isoDateTimeSchema, roomIdSchema, sessionIdSchema } from './primitives.js'

/** Every source converges on the same moderation queue. */
export const commentSourceSchema = z.enum(['form', 'bluesky', 'mastodon', 'x'])
export type CommentSource = z.infer<typeof commentSourceSchema>

export const moderationStatusSchema = z.enum(['pending', 'approved', 'rejected'])

export const commentSchema = z.object({
  id: z.string(),
  source: commentSourceSchema,
  author: z.string().max(80),
  /** Origin handle for social sources, `null` for the form. */
  authorHandle: z.string().nullable(),
  text: z.string().max(500),
  status: moderationStatusSchema,
  roomId: roomIdSchema.nullable(),
  sessionId: sessionIdSchema.nullable(),
  createdAt: isoDateTimeSchema,
})
export type Comment = z.infer<typeof commentSchema>

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
