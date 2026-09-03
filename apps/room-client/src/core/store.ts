import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { desc, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { openDatabase } from '@cloudnord/db'
import {
  appliedCommand,
  clientSchema,
  journal,
  programCache,
  roomSettings,
} from '@cloudnord/db/client'
import { programSchema, type Program } from '@cloudnord/program'
import {
  eventIdentitySchema,
  DEFAULT_EVENT_IDENTITY,
  roomConfigSchema,
  socialLinkSchema,
  vodSyncSchema,
  type EventIdentity,
  type RoomConfig,
  type SocialLink,
  type VodSync,
} from '@cloudnord/contract'

/**
 * The accounts read back from the local cache.
 *
 * Tolerant: a corrupt JSON or a schema that has moved must not stop the room from
 * starting for a decorative page. The loop will simply skip its social page.
 */
function readSocialLinks(raw: string | null): SocialLink[] {
  if (raw == null) return []
  try {
    const parsed = socialLinkSchema.array().safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

/**
 * The shipping settings read back from the cache.
 *
 * `null` — cache absent, unreadable, or a schema that has moved — means "no
 * destination", so nothing leaves. It is the fallback we want: a room that no
 * longer knows what the hub expects of it must not start uploading on a guess.
 */
function readVod(raw: string | null): VodSync | null {
  if (raw == null) return null
  try {
    const parsed = vodSyncSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * The event's identity, read back from the local cache.
 *
 * The fallback is neutral and not an event name: a machine that has never
 * synchronized does not know yet where it is, and displaying another edition's
 * name would be worse than claiming nothing. The first sync corrects it.
 */
function readIdentity(raw: string | null): EventIdentity {
  if (raw == null) return DEFAULT_EVENT_IDENTITY
  try {
    const parsed = eventIdentitySchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : DEFAULT_EVENT_IDENTITY
  } catch {
    return DEFAULT_EVENT_IDENTITY
  }
}

/**
 * The local migrations folder.
 *
 * Two locations depending on the context: from the sources it lives in the
 * monorepo; in the installed application, electron-builder copies it under
 * `resources/`. Resolving only the first would produce an application that starts
 * in development and crashes on installation — the kind of failure one discovers
 * the day before.
 *
 * The monorepo's path is **searched for**, not counted. This file is loaded from
 * two different depths: `src/core/store.ts` under `tsx`, and `dist/main.cjs` once
 * bundled for Electron, where the whole application core is flattened into a
 * single file. A number of `..` right for one is wrong for the other — and that is
 * what made the Electron client crash at startup, on a "Can't find
 * meta/_journal.json" that names neither the folder searched for nor the reason.
 */
function resolveMigrationsFolder(): string {
  const packaged = process.resourcesPath
  if (packaged != null) {
    const candidate = join(packaged, 'migrations', 'client')
    if (existsSync(candidate)) return candidate
  }

  const visited: string[] = []
  let directory = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(directory, 'packages', 'db', 'migrations', 'client')
    visited.push(candidate)
    if (existsSync(candidate)) return candidate
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }

  // Said plainly, and with what was tried: with no migrations, the local database
  // does not exist, and with no local database there is no room.
  throw new Error(
    [
      'Migrations locales introuvables : la salle ne peut pas ouvrir sa base.',
      "Dans l'application installée, elles voyagent sous resources/migrations/client",
      "(extraResources d'electron-builder) ; depuis les sources, dans packages/db/migrations/client.",
      'Cherchées ici :',
      ...visited.map((path) => `    ${path}`),
    ].join('\n'),
  )
}

/** A single row: the room's settings fit in one record. */
const SETTINGS_ID = 1

export interface RoomSettings {
  roomId: string | null
  token: string | null
  config: RoomConfig | null
  activeContentHash: string | null
  /** The event's accounts, pushed by the hub. Cached like the program. */
  socialLinks: SocialLink[]
  /**
   * The event's name, pushed by the hub. Cached for the same reason.
   *
   * It is what titles the windows and the waiting loop: writing it in hard made a
   * machine installed for one edition unable to serve another without a
   * reinstallation.
   */
  event: EventIdentity
  /** The shipping destination and policy, pushed by the hub. */
  vod: VodSync | null
  nextSeq: number
  lastCommandSeq: number
  clockOffsetMs: number
}

/**
 * The machine's persistent local state.
 *
 * It is the foundation of the self-sufficiency: the program, the settings and the
 * command stream's progress survive a crash, a restart and a whole day with no
 * network. A room starts from this database alone.
 */
export class LocalStore {
  private readonly orm: ReturnType<typeof drizzle<typeof clientSchema>>

  constructor(private readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    const sqlite = openDatabase({ path })
    this.orm = drizzle(sqlite, { schema: clientSchema })
    try {
      migrate(this.orm, { migrationsFolder: resolveMigrationsFolder() })
    } catch (cause) {
      // The same situation as on the hub side: a database created with an earlier
      // schema. Drizzle's raw trace does not say what to do; this message does.
      const detail = String((cause as { cause?: { message?: string } })?.cause?.message ?? '')
      if (/already exists/i.test(detail)) {
        throw new Error(
          [
            `Migration impossible : la base locale ${path} ne reconnaît pas les migrations.`,
            '',
            "Comme côté hub, la cause habituelle est une migration régénérée plutôt qu'ajoutée :",
            '    git checkout -- packages/db/migrations',
            '',
            'Cette base ne contient que du cache et une file de remontée. La supprimer est sans',
            "conséquence UNIQUEMENT si le compteur d'événements en attente est à zéro — sinon",
            'elle emporte des enregistrements et des marqueurs jamais remontés au hub.',
            `    rm -rf ${dirname(path)}`,
            '',
            'La machine devra être réappairée au prochain démarrage.',
            `Détail : ${detail}`,
          ].join('\n'),
          { cause },
        )
      }
      throw cause
    }
    this.ensureSettingsRow()
  }

  get db() {
    return this.orm
  }

  private ensureSettingsRow(): void {
    this.orm.insert(roomSettings).values({ id: SETTINGS_ID }).onConflictDoNothing().run()
  }

  settings(): RoomSettings {
    const row = this.orm.select().from(roomSettings).where(eq(roomSettings.id, SETTINGS_ID)).get()
    return {
      roomId: row?.roomId ?? null,
      token: row?.token ?? null,
      config: row?.configJson == null ? null : roomConfigSchema.parse(JSON.parse(row.configJson)),
      activeContentHash: row?.activeContentHash ?? null,
      // A decorative setting: an unreadable cache must not stop the room from
      // starting, the loop will simply skip its social page.
      socialLinks: readSocialLinks(row?.socialLinksJson ?? null),
      event: readIdentity(row?.eventIdentityJson ?? null),
      vod: readVod(row?.vodJson ?? null),
      nextSeq: row?.nextSeq ?? 1,
      lastCommandSeq: row?.lastCommandSeq ?? 0,
      clockOffsetMs: row?.clockOffsetMs ?? 0,
    }
  }

  saveSettings(patch: Partial<Omit<RoomSettings, 'config'>> & { config?: RoomConfig }): void {
    const update: Record<string, unknown> = { updatedAt: new Date().toISOString() }
    if (patch.roomId !== undefined) update.roomId = patch.roomId
    if (patch.token !== undefined) update.token = patch.token
    if (patch.config !== undefined) update.configJson = JSON.stringify(patch.config)
    if (patch.activeContentHash !== undefined) update.activeContentHash = patch.activeContentHash
    if (patch.socialLinks !== undefined) update.socialLinksJson = JSON.stringify(patch.socialLinks)
    if (patch.event !== undefined) update.eventIdentityJson = JSON.stringify(patch.event)
    if (patch.vod !== undefined) update.vodJson = patch.vod == null ? null : JSON.stringify(patch.vod)
    if (patch.lastCommandSeq !== undefined) update.lastCommandSeq = patch.lastCommandSeq
    if (patch.clockOffsetMs !== undefined) update.clockOffsetMs = patch.clockOffsetMs

    this.orm.update(roomSettings).set(update).where(eq(roomSettings.id, SETTINGS_ID)).run()
  }

  /**
   * Reserves the next outbound `seq`.
   *
   * Monotonic and never reset, including after a restart: it is what lets the hub
   * apply the events in emission order even when they come up hours later.
   */
  nextOutboundSeq(): number {
    const row = this.orm
      .update(roomSettings)
      .set({ nextSeq: sql`${roomSettings.nextSeq} + 1` })
      .where(eq(roomSettings.id, SETTINGS_ID))
      .returning({ nextSeq: roomSettings.nextSeq })
      .get()
    return row.nextSeq - 1
  }

  /** Records a snapshot and makes it active. */
  saveProgram(contentHash: string, program: Program): void {
    this.orm.transaction((tx) => {
      tx.update(programCache).set({ active: false }).run()
      tx.insert(programCache)
        .values({ contentHash, programJson: JSON.stringify(program), active: true })
        .onConflictDoUpdate({
          target: programCache.contentHash,
          set: { programJson: JSON.stringify(program), active: true, syncedAt: new Date().toISOString() },
        })
        .run()
      tx.update(roomSettings)
        .set({ activeContentHash: contentHash })
        .where(eq(roomSettings.id, SETTINGS_ID))
        .run()
    })
  }

  /**
   * The active cached program.
   *
   * Returns `null` rather than throwing if the cache is corrupt: a fallback screen
   * beats an application that refuses to start in front of a room.
   */
  activeProgram(): { contentHash: string; program: Program } | null {
    const row = this.orm.select().from(programCache).where(eq(programCache.active, true)).get()
    if (row == null) return null
    const parsed = programSchema.safeParse(JSON.parse(row.programJson))
    if (!parsed.success) return null
    return { contentHash: row.contentHash, program: parsed.data }
  }

  /** A command already applied must not be applied twice after a reconnection. */
  hasApplied(seq: number): boolean {
    return (
      this.orm.select().from(appliedCommand).where(eq(appliedCommand.seq, seq)).get() !== undefined
    )
  }

  markApplied(seq: number, type: string): void {
    this.orm.transaction((tx) => {
      tx.insert(appliedCommand).values({ seq, type }).onConflictDoNothing().run()
      tx.update(roomSettings)
        .set({ lastCommandSeq: sql`max(${roomSettings.lastCommandSeq}, ${seq})` })
        .where(eq(roomSettings.id, SETTINGS_ID))
        .run()
    })
  }

  /**
   * The local log.
   *
   * It is the only usable trace when the network has been absent all day: events
   * rejected for good, OBS incidents, expirations. Accepts a transaction so it can
   * be written in the same atom as the deletion it justifies.
   */
  log(
    level: 'info' | 'warn' | 'error',
    message: string,
    context?: unknown,
    tx?: Pick<LocalStore['db'], 'insert'>,
  ): void {
    ;(tx ?? this.orm)
      .insert(journal)
      .values({
        level,
        message,
        contextJson: context == null ? null : JSON.stringify(context),
      })
      .run()
  }

  /** The most recent log entries, for the diagnostic panel in the control app. */
  recentLogs(limit = 50) {
    return this.orm
      .select()
      .from(journal)
      .orderBy(desc(journal.id))
      .limit(limit)
      .all()
  }

  close(): void {
    // `better-sqlite3` exposes the connection under `$client` through Drizzle.
    ;(this.orm as unknown as { $client: { close: () => void } }).$client.close()
  }
}
