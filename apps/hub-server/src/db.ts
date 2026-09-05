import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { openDatabase, type SqliteDatabase } from '@conference-operator/db'
import { hubSchema } from '@conference-operator/db/hub'

export type HubDatabase = ReturnType<typeof drizzle<typeof hubSchema>>

/**
 * Transaction handle. Drizzle makes it a distinct type from the database: the
 * functions that must run *inside* a transaction are annotated with this one.
 */
export type HubTransaction = Parameters<Parameters<HubDatabase['transaction']>[0]>[0]

/** `@conference-operator/db`'s migrations folder, resolved from this package. */
const migrationsFolder = fileURLToPath(
  new URL('../../../packages/db/migrations/hub', import.meta.url),
)

export interface OpenHubDbResult {
  /** Raw connection: Better Auth reuses it, for a single file and a single lock. */
  sqlite: SqliteDatabase
  orm: HubDatabase
}

export function openHubDatabase(path: string): OpenHubDbResult {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const sqlite = openDatabase({ path })
  const orm = drizzle(sqlite, { schema: hubSchema })

  try {
    migrate(orm, { migrationsFolder })
  } catch (cause) {
    sqlite.close()
    throw explainMigrationFailure(cause, path)
  }

  return { sqlite, orm }
}

/**
 * Turns a migration failure into an actionable instruction.
 *
 * The common case in development: the baseline was regenerated while the
 * database already existed. Drizzle no longer recognises the applied migration
 * and replays the `CREATE TABLE`s, which fail. The raw trace says nothing about
 * what to do — that is this message's job.
 */
function explainMigrationFailure(cause: unknown, path: string): Error {
  const message = String((cause as { cause?: { message?: string } })?.cause?.message ?? '')

  if (/already exists/i.test(message)) {
    return new Error(
      [
        `Migration impossible : la base ${path} ne reconnaît pas les migrations du dépôt.`,
        '',
        "La cause quasi certaine n'est pas la base mais les fichiers : une migration déjà",
        'appliquée a été régénérée, donc son empreinte a changé. Restaurez-les — la base,',
        'elle, contient les comptes opérateurs, les appairages et la modération du jour.',
        '    git checkout -- packages/db/migrations',
        '',
        "Si le schéma a réellement évolué, la migration doit s'ajouter, jamais remplacer :",
        '    pnpm --filter @conference-operator/db generate:hub && pnpm --filter @conference-operator/db seal',
        '',
        'En dernier recours seulement, et seulement si cette base est jetable :',
        `    rm -rf ${dirname(path)}`,
        '    pnpm --filter @conference-operator/hub-server operator <email> "<nom>" <mot-de-passe>',
        '    (les machines de salle devront être réappairées)',
        `Détail : ${message}`,
      ].join('\n'),
      { cause },
    )
  }
  return cause instanceof Error ? cause : new Error(String(cause))
}
