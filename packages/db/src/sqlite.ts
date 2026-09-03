import Database from 'better-sqlite3'

export interface OpenOptions {
  /** File path, or `:memory:` for tests. */
  path: string
  /** Maximum wait on a write lock. */
  busyTimeoutMs?: number
  readonly?: boolean
}

/**
 * Opens a SQLite database with the settings we want everywhere — hub as well as
 * client.
 *
 * WAL is the important part: it allows concurrent reads during a write. On the
 * hub side, that is what lets the public wall be served while the rooms' events
 * are ingested; on the client side, it lets the screen render while the outbox
 * drains.
 */
export function openDatabase({ path, busyTimeoutMs = 5_000, readonly = false }: OpenOptions) {
  const db = new Database(path, { readonly })
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma(`busy_timeout = ${busyTimeoutMs}`)
  db.pragma('foreign_keys = ON')
  return db
}

export type SqliteDatabase = Database.Database
