import { z } from 'zod'
import { notifLevelsSchema } from './room-state.js'

/**
 * Where the supervision notices go besides the consoles.
 *
 * Web Push reaches a browser; an integration reaches a team — a Slack or
 * Mattermost channel, or any system behind a webhook. Same notices, same two
 * families and three levels: an integration is one more recipient, not a second
 * set of rules.
 */
export const integrationKindSchema = z.enum(['slack', 'mattermost', 'webhook'])
export type IntegrationKind = z.infer<typeof integrationKindSchema>

/**
 * An integration as the console sees it.
 *
 * The address and the secret never come back whole: a webhook URL *is* a
 * credential — whoever reads it can post in the channel. The console shows
 * enough to recognise it, and replaces it rather than edits it.
 */
export const integrationViewSchema = z.object({
  id: z.string(),
  kind: integrationKindSchema,
  name: z.string(),
  enabled: z.boolean(),
  /** Masked: scheme, host and the last four characters. */
  url: z.string(),
  hasSecret: z.boolean(),
  levels: notifLevelsSchema,
  createdAt: z.string(),
  lastSentAt: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  lastError: z.string().nullable(),
})
export type IntegrationView = z.infer<typeof integrationViewSchema>

export const integrationCreateSchema = z.object({
  kind: integrationKindSchema,
  name: z.string().trim().min(1).max(80),
  url: z.url({ protocol: /^https?$/ }),
  /** Signs the generic webhook's body (HMAC-SHA256). Ignored for Slack and Mattermost. */
  secret: z.string().min(1).max(200).nullable().default(null),
  levels: notifLevelsSchema.default({ technique: 'essentiel', exploitation: 'essentiel' }),
  enabled: z.boolean().default(true),
})

/**
 * Partial: what is absent stays as it is.
 *
 * That is what lets the console change a level without knowing the URL it was
 * never given. `secret: null` removes the secret; an absent secret keeps it.
 */
export const integrationUpdateSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(80).optional(),
  url: z.url({ protocol: /^https?$/ }).optional(),
  secret: z.string().min(1).max(200).nullable().optional(),
  levels: notifLevelsSchema.optional(),
  enabled: z.boolean().optional(),
})

export const integrationTestResultSchema = z.object({
  ok: z.boolean(),
  status: z.number().nullable(),
  error: z.string().nullable(),
})
export type IntegrationTestResult = z.infer<typeof integrationTestResultSchema>
