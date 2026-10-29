import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { SqliteDatabase } from '@conference-operator/db'

/**
 * The hub's configuration, as one file: what a reset must not cost.
 *
 * Settings (the loop included), rooms, integrations, the program and its
 * corrections, the posts written or put forward in the console, the operators'
 * accounts, and the images and themes beside the database. Not what the day
 * produces: room states, logs, statistics, the audience's messages, the
 * machines' pairings — a production hub starts those afresh.
 *
 * Rows travel as the database holds them, table by table: the file restores on a
 * hub of the same version or a newer one, whose new columns take their defaults.
 * The secrets the hub seals (walls.io, Git, stream keys) stay sealed: they open
 * again only on a hub with the same `BETTER_AUTH_SECRET`, and the restore says
 * which ones to type again otherwise. The file still carries the operators'
 * password hashes and the webhooks' addresses: it is kept like a secret.
 */
export const SAUVEGARDE_FORMAT = 'conference-operator/sauvegarde'

/** Tables restored whole, every row. */
const TABLES = [
  'hub_setting',
  'room',
  'integration',
  'program_snapshot',
  'session_override',
  'session_feedback',
  'session_slot',
  'asset',
  'user',
  'account',
] as const

/**
 * What of `hub_setting` stays behind: the push keys belong to the browsers
 * subscribed to this hub, and those subscriptions do not travel.
 */
const SETTINGS_LEFT = new Set(['push.vapid'])

/** The posts that are configuration: written in the console, put forward, or shown despite walls.io. */
const POSTS_KEPT = "source = 'hub' or featured = 1 or forced_on_screen = 1"

/**
 * An image or a theme file, as the stores name them — an image whose address names
 * no type has no extension. Nothing else is written back.
 */
const FILE_NAME = /^[0-9a-f]{64}(\.[a-z0-9]{1,8}){0,2}$/

const rowSchema = z.record(z.string(), z.unknown())

export const sauvegardeSchema = z.object({
  format: z.literal(SAUVEGARDE_FORMAT),
  version: z.literal(1),
  creeLe: z.string(),
  /** The last migration of the hub that wrote it: a restoring hub must have it. */
  migration: z.string(),
  tables: z.record(z.string(), z.array(rowSchema)),
  fichiers: z.object({
    images: z.record(z.string(), z.string()),
    themes: z.record(z.string(), z.string()),
  }),
})
export type Sauvegarde = z.infer<typeof sauvegardeSchema>

export interface RestaurationReport {
  lignes: Record<string, number>
  /** Accounts left out: their address already exists here (the initial admin, for one). */
  comptesIgnores: string[]
  fichiers: { images: number; themes: number }
  /** Sealed secrets this hub cannot open: to type again in the console. */
  aRessaisir: string[]
}

export class SauvegardeError extends Error {}

/** A column holding bytes travels as `{ $base64 }`: JSON has no bytes. */
const encode = (value: unknown): unknown => (Buffer.isBuffer(value) ? { $base64: value.toString('base64') } : value)
const decode = (value: unknown): unknown =>
  value != null && typeof value === 'object' && typeof (value as { $base64?: unknown }).$base64 === 'string'
    ? Buffer.from((value as { $base64: string }).$base64, 'base64')
    : value

export class SauvegardeService {
  constructor(
    private readonly options: {
      sqlite: SqliteDatabase
      imagesDir: string | null
      themesDir: string | null
      /** Opens a sealed secret; `null` when this hub's key cannot. */
      open: (sealed: string) => string | null
      now: () => Date
    },
  ) {}

  export(): Sauvegarde {
    const { sqlite } = this.options
    const tables: Record<string, Record<string, unknown>[]> = {}
    for (const table of TABLES) {
      const rows = sqlite.prepare(`select * from "${table}"`).all() as Record<string, unknown>[]
      tables[table] = (table === 'hub_setting' ? rows.filter((row) => !SETTINGS_LEFT.has(String(row.key))) : rows).map(
        (row) => Object.fromEntries(Object.entries(row).map(([column, value]) => [column, encode(value)])),
      )
    }
    tables.comment = (sqlite.prepare(`select * from comment where ${POSTS_KEPT}`).all() as Record<string, unknown>[]).map(
      ({ seq: _seq, ...row }) => row,
    )
    return {
      format: SAUVEGARDE_FORMAT,
      version: 1,
      creeLe: this.options.now().toISOString(),
      migration: this.lastMigration(),
      tables,
      fichiers: { images: readFolder(this.options.imagesDir), themes: readFolder(this.options.themesDir) },
    }
  }

  /**
   * Writes a backup into this hub, over what it holds: a row with the same key
   * takes the backup's values, nothing is deleted. All the rows or none.
   */
  restore(raw: unknown): RestaurationReport {
    const parsed = sauvegardeSchema.safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new SauvegardeError(`Fichier non reconnu : ce n’est pas une sauvegarde du hub (${issue?.path.join('.') || 'racine'} : ${issue?.message ?? 'forme inattendue'}).`)
    }
    const backup = parsed.data
    const { sqlite } = this.options
    const applied = new Set((sqlite.prepare('select hash from __drizzle_migrations').all() as { hash: string }[]).map((row) => row.hash))
    if (!applied.has(backup.migration)) {
      throw new SauvegardeError('Sauvegarde faite par un hub plus récent que celui-ci : mettez ce hub à jour, puis restaurez.')
    }

    const report: RestaurationReport = { lignes: {}, comptesIgnores: [], fichiers: { images: 0, themes: 0 }, aRessaisir: [] }
    const allowed = new Set<string>([...TABLES, 'comment'])
    sqlite.transaction(() => {
      const skippedUsers = new Set<string>()
      for (const table of [...TABLES, 'comment']) {
        const rows = backup.tables[table] ?? []
        if (!allowed.has(table) || rows.length === 0) continue
        const columns = sqlite.prepare(`select name, pk from pragma_table_info('${table}')`).all() as { name: string; pk: number }[]
        const known = new Set(columns.map((column) => column.name))
        const keys = table === 'comment' ? ['id'] : columns.filter((column) => column.pk > 0).map((column) => column.name)
        let written = 0
        for (const raw of rows) {
          const row = Object.fromEntries(
            Object.entries(raw).filter(([column]) => known.has(column) && !(table === 'comment' && column === 'seq')).map(([column, value]) => [column, decode(value)]),
          )
          if (table === 'hub_setting' && SETTINGS_LEFT.has(String(row.key))) continue
          if (table === 'user') {
            const taken = sqlite.prepare('select id from "user" where email = ? and id != ?').get(row.email, row.id)
            if (taken != null) {
              skippedUsers.add(String(row.id))
              report.comptesIgnores.push(String(row.email))
              continue
            }
          }
          if (table === 'account' && skippedUsers.has(String(row.userId))) continue
          const names = Object.keys(row)
          const quoted = names.map((name) => `"${name}"`).join(', ')
          const update = names.filter((name) => !keys.includes(name)).map((name) => `"${name}" = excluded."${name}"`)
          const conflict = keys.length === 0
            ? ''
            : update.length === 0
              ? ` on conflict(${keys.map((key) => `"${key}"`).join(', ')}) do nothing`
              : ` on conflict(${keys.map((key) => `"${key}"`).join(', ')}) do update set ${update.join(', ')}`
          sqlite.prepare(`insert into "${table}" (${quoted}) values (${names.map(() => '?').join(', ')})${conflict}`).run(
            ...names.map((name) => toSqlite(row[name])),
          )
          written += 1
        }
        report.lignes[table] = written
      }
    })()

    report.fichiers.images = writeFolder(this.options.imagesDir, backup.fichiers.images)
    report.fichiers.themes = writeFolder(this.options.themesDir, backup.fichiers.themes)
    report.aRessaisir = this.unreadableSecrets()
    return report
  }

  private lastMigration(): string {
    const row = this.options.sqlite.prepare('select hash from __drizzle_migrations order by created_at desc, id desc limit 1').get() as
      | { hash: string }
      | undefined
    return row?.hash ?? ''
  }

  /** The sealed secrets now held that this hub's key does not open. */
  private unreadableSecrets(): string[] {
    const { sqlite, open } = this.options
    const out: string[] = []
    const setting = (key: string) => {
      const row = sqlite.prepare('select value_json from hub_setting where key = ?').get(key) as { value_json: string } | undefined
      try {
        return row == null ? null : (JSON.parse(row.value_json) as Record<string, unknown>)
      } catch {
        return null
      }
    }
    const wallsio = setting('wallsio')?.tokenSealed
    if (typeof wallsio === 'string' && open(wallsio) == null) out.push('Jeton walls.io (Réglages → Mur social — walls.io)')
    const git = setting('gitSource')?.jetonScelle
    if (typeof git === 'string' && open(git) == null) out.push('Jeton du dépôt Git (Boucle → Dépôt Git)')
    for (const room of sqlite.prepare('select id, stream_key_enc from room where stream_key_enc is not null').all() as { id: string; stream_key_enc: string }[]) {
      if (open(room.stream_key_enc) == null) out.push(`Clé de diffusion de la salle ${room.id} (Réglages → Diffusion)`)
    }
    return out
  }
}

/** better-sqlite3 binds no booleans and no objects: what JSON gave back, as SQLite stores it. */
function toSqlite(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value != null && typeof value === 'object' && !Buffer.isBuffer(value)) return JSON.stringify(value)
  return value
}

function readFolder(dir: string | null): Record<string, string> {
  if (dir == null || !existsSync(dir)) return {}
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => FILE_NAME.test(name))
      .map((name) => [name, readFileSync(join(dir, name)).toString('base64')]),
  )
}

function writeFolder(dir: string | null, files: Record<string, string>): number {
  if (dir == null) return 0
  mkdirSync(dir, { recursive: true })
  let written = 0
  for (const [name, content] of Object.entries(files)) {
    if (!FILE_NAME.test(name) || existsSync(join(dir, name))) continue
    writeFileSync(join(dir, name), Buffer.from(content, 'base64'))
    written += 1
  }
  return written
}
