import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { imageRefSchema } from '@conference-operator/contract'
import { hubSetting } from '@conference-operator/db/hub'
import type { HubDatabase } from '../db.js'
import type { SettingsService } from './sessions.js'
import type { WallService } from './wall.js'

/** The hand-fed posts, as the loop settings stored them before the social wall. */
const legacySchema = z.looseObject({
  screensDisabled: z.array(z.unknown()).optional(),
  boucle: z
    .looseObject({
      mur: z
        .looseObject({
          posts: z
            .array(
              z.looseObject({
                auteur: z.string(),
                titre: z.string().nullish(),
                photo: imageRefSchema.nullish(),
                texte: z.string().nullish(),
                image: imageRefSchema.nullish(),
                reseau: z.string().nullish(),
              }),
            )
            .default([]),
        })
        .optional(),
    })
    .optional(),
})

export interface LegacyMurReport {
  imported: number
  /** The loop's hand-fed page had been withdrawn: its posts were not brought back. */
  skipped: number
}

/**
 * Brings the hand-fed posts of the loop into the social wall, once.
 *
 * They were typed in the loop settings, a page of their own; they are now the
 * hub's posts, put forward on the social wall — the same cards, one page fewer.
 * At startup rather than in a SQL migration, for the same reason as the
 * OpenFeedback takeover: the value lives inside a JSON blob, and the services
 * already know how to read and rewrite it.
 *
 * Idempotent twice over: each post carries a key derived from its content, and
 * the settings are rewritten without the section — at the next startup there is
 * nothing left to take.
 */
export function migrateLegacyMur(db: HubDatabase, settings: SettingsService, wall: WallService): LegacyMurReport | null {
  const row = db.select().from(hubSetting).where(eq(hubSetting.key, 'hub')).get()
  if (row == null) return null
  const parsed = legacySchema.safeParse(JSON.parse(row.valueJson))
  if (!parsed.success || parsed.data.boucle?.mur == null) return null

  const posts = parsed.data.boucle.mur.posts
  // Withdrawn by the organisers: bringing them back on the social wall would
  // undo their decision.
  const withdrawn = parsed.data.screensDisabled?.includes('posts') ?? false
  let imported = 0
  if (!withdrawn) {
    for (const post of posts) {
      const key = `mur:${createHash('sha256').update(JSON.stringify(post)).digest('hex').slice(0, 32)}`
      const saved = wall.saveHubPost(
        {
          author: post.auteur.slice(0, 80),
          authorSubtitle: post.titre?.slice(0, 120) || null,
          avatar: post.photo ?? null,
          text: (post.texte ?? '').slice(0, 1500),
          image: post.image ?? null,
          network: post.reseau?.slice(0, 30) || null,
          featured: true,
        },
        'reprise de la boucle',
        key,
      )
      if (saved != null) imported += 1
    }
  }
  // Rewritten through the schema, which no longer knows the section.
  settings.update({})
  return { imported, skipped: withdrawn ? posts.length : 0 }
}
