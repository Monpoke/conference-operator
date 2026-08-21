import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { openDatabase, type SqliteDatabase } from '@cloudnord/db'
import { hubSchema } from '@cloudnord/db/hub'

export type HubDatabase = ReturnType<typeof drizzle<typeof hubSchema>>

/**
 * Handle transactionnel. Drizzle en fait un type distinct de la base : les
 * fonctions qui doivent tourner *dans* une transaction s'annotent avec celui-ci.
 */
export type HubTransaction = Parameters<Parameters<HubDatabase['transaction']>[0]>[0]

/** Dossier de migrations de `@cloudnord/db`, résolu depuis ce package. */
const migrationsFolder = fileURLToPath(
  new URL('../../../packages/db/migrations/hub', import.meta.url),
)

export interface OpenHubDbResult {
  /** Connexion brute : Better Auth la réutilise, pour un seul fichier et un seul verrou. */
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
    throw expliquerEchecMigration(cause, path)
  }

  return { sqlite, orm }
}

/**
 * Traduit un échec de migration en instruction actionnable.
 *
 * Le cas courant en développement : la ligne de base a été régénérée pendant
 * que la base existait déjà. Drizzle ne reconnaît plus la migration appliquée
 * et rejoue les `CREATE TABLE`, qui échouent. La trace brute ne dit rien de ce
 * qu'il faut faire — c'est le rôle de ce message.
 */
function expliquerEchecMigration(cause: unknown, path: string): Error {
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
        '    pnpm --filter @cloudnord/db generate:hub && pnpm --filter @cloudnord/db sceller',
        '',
        'En dernier recours seulement, et seulement si cette base est jetable :',
        `    rm -rf ${dirname(path)}`,
        '    pnpm --filter @cloudnord/hub-server operator <email> "<nom>" <mot-de-passe>',
        '    (les machines de salle devront être réappairées)',
        `Détail : ${message}`,
      ].join('\n'),
      { cause },
    )
  }
  return cause instanceof Error ? cause : new Error(String(cause))
}
