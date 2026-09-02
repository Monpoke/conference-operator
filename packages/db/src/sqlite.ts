import Database from 'better-sqlite3'

export interface OpenOptions {
  /** Chemin du fichier, ou `:memory:` pour les tests. */
  path: string
  /** Attente max sur un verrou d'écriture. */
  busyTimeoutMs?: number
  readonly?: boolean
}

/**
 * Ouvre une base SQLite avec les réglages qu'on veut partout — hub comme client.
 *
 * WAL est le point important : il autorise des lectures concurrentes pendant une
 * écriture. Côté hub, c'est ce qui permet de servir le mur public pendant qu'on
 * ingère les événements des salles ; côté client, de rendre l'écran pendant que
 * l'outbox se vide.
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
