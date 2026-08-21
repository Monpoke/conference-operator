import { z } from 'zod'
import type { Program } from './model.js'

/**
 * Schéma zod du modèle *normalisé* (à ne pas confondre avec `raw-schema.ts`, qui
 * décrit le JSON amont).
 *
 * Sert à valider un snapshot reçu sur le fil ou relu depuis le cache SQLite :
 * le client ne doit pas afficher un programme corrompu sur le projecteur.
 *
 * Les interfaces de `model.ts` restent la référence pour la lecture ; l'assertion
 * de compatibilité en fin de fichier fait échouer le typecheck si les deux dérivent.
 */

export const socialSchema = z.object({
  name: z.string(),
  icon: z.string().nullable(),
  url: z.string(),
})

export const speakerSchema = z.object({
  id: z.string(),
  name: z.string(),
  jobTitle: z.string().nullable(),
  company: z.string().nullable(),
  bio: z.string().nullable(),
  photoUrl: z.string().nullable(),
  companyLogoUrl: z.string().nullable(),
  socials: z.array(socialSchema),
})

export const categorySchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  colorSecondary: z.string().nullable(),
})

export const formatSchema = z.object({
  id: z.string(),
  name: z.string(),
  durationMinutes: z.number().nullable(),
})

export const roomSchema = z.object({
  id: z.string(),
  name: z.string(),
})

export const sessionKindSchema = z.enum(['talk', 'break'])

export const sessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  abstract: z.string().nullable(),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  startsAtMs: z.number(),
  endsAtMs: z.number().nullable(),
  durationMinutes: z.number().nullable(),
  roomId: z.string().nullable(),
  kind: sessionKindSchema,
  speakers: z.array(speakerSchema),
  category: categorySchema.nullable(),
  format: formatSchema.nullable(),
  language: z.string().nullable(),
  level: z.string().nullable(),
  tags: z.array(z.string()),
  imageUrl: z.string().nullable(),
})

export const sponsorSchema = z.object({
  id: z.string(),
  name: z.string(),
  website: z.string().nullable(),
  logoUrl: z.string().nullable(),
})

export const sponsorTierSchema = z.object({
  id: z.string(),
  name: z.string(),
  order: z.number(),
  sponsors: z.array(sponsorSchema),
})

export const eventInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  locationName: z.string().nullable(),
  locationUrl: z.string().nullable(),
  language: z.string().nullable(),
  theme: z.object({
    color: z.string().nullable(),
    colorSecondary: z.string().nullable(),
    colorBackground: z.string().nullable(),
  }),
  logoUrl: z.string().nullable(),
  logoUrl2: z.string().nullable(),
  backgroundUrl: z.string().nullable(),
  intermissionMediaUrl: z.string().nullable(),
})

export const programIssueSchema = z.object({
  code: z.enum([
    'unknown-speaker',
    'unknown-track',
    'invalid-social-url',
    'missing-date',
    'duplicate-id',
  ]),
  message: z.string(),
  ref: z.string().optional(),
})

export const programSchema = z.object({
  event: eventInfoSchema,
  timezone: z.string(),
  generatedAt: z.string().nullable(),
  rooms: z.array(roomSchema),
  sessions: z.array(sessionSchema),
  speakers: z.array(speakerSchema),
  categories: z.array(categorySchema),
  formats: z.array(formatSchema),
  sponsorTiers: z.array(sponsorTierSchema),
  issues: z.array(programIssueSchema),
})

/**
 * Garde-fou de compilation : si `model.ts` et `programSchema` divergent, l'une
 * de ces deux affectations cesse de compiler.
 */
type SchemaProgram = z.infer<typeof programSchema>
const _schemaMatchesModel: SchemaProgram = null as unknown as Program
const _modelMatchesSchema: Program = null as unknown as SchemaProgram
void _schemaMatchesModel
void _modelMatchesSchema
