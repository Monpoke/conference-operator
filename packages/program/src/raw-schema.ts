import { z } from 'zod'

/**
 * Schéma du JSON amont (export « conference-center »).
 *
 * Tolérant par conception : `looseObject` laisse passer les champs inconnus et
 * la plupart des valeurs sont `nullish`. Un export enrichi en amont ne doit
 * jamais faire échouer un import le jour J — c'est le normaliseur, en aval, qui
 * décide de ce qui est réellement exploitable.
 */

const nullableString = z.string().nullish()

export const rawSocialSchema = z.looseObject({
  name: nullableString,
  icon: nullableString,
  link: nullableString,
})

export const rawTrackSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
})

export const rawFormatSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  durationMinutes: z.number().nullish(),
})

export const rawCategorySchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  color: nullableString,
  colorSecondary: nullableString,
})

export const rawEventSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  dateStart: nullableString,
  dateEnd: nullableString,
  color: nullableString,
  colorSecondary: nullableString,
  colorBackground: nullableString,
  logoUrl: nullableString,
  logoUrl2: nullableString,
  backgroundUrl: nullableString,
  intermissionMediaUrl: nullableString,
  locationName: nullableString,
  locationUrl: nullableString,
  language: nullableString,
  tracks: z.array(rawTrackSchema).nullish(),
  formats: z.array(rawFormatSchema).nullish(),
  categories: z.array(rawCategorySchema).nullish(),
})

export const rawSpeakerSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  jobTitle: nullableString,
  bio: nullableString,
  company: nullableString,
  companyLogoUrl: nullableString,
  photoUrl: nullableString,
  socials: z.array(rawSocialSchema).nullish(),
})

export const rawSessionSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  abstract: nullableString,
  dateStart: nullableString,
  dateEnd: nullableString,
  durationMinutes: z.number().nullish(),
  speakerIds: z.array(z.string()).nullish(),
  trackId: nullableString,
  formatId: nullableString,
  categoryId: nullableString,
  language: nullableString,
  level: nullableString,
  imageUrl: nullableString,
  tags: z.array(z.string()).nullish(),
})

export const rawSponsorSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  website: nullableString,
  logoUrl: nullableString,
})

export const rawSponsorTierSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  order: z.number().nullish(),
  sponsors: z.array(rawSponsorSchema).nullish(),
})

export const rawProgramSchema = z.looseObject({
  event: rawEventSchema,
  speakers: z.array(rawSpeakerSchema).nullish(),
  sessions: z.array(rawSessionSchema).nullish(),
  sponsors: z.array(rawSponsorTierSchema).nullish(),
  timezone: nullableString,
  generatedAt: nullableString,
})

export type RawProgram = z.infer<typeof rawProgramSchema>

export type RawSocial = z.infer<typeof rawSocialSchema>
export type RawSession = z.infer<typeof rawSessionSchema>
export type RawSpeaker = z.infer<typeof rawSpeakerSchema>
