/**
 * Seals the published migrations.
 *
 * Drizzle identifies an applied migration by the hash of its content.
 * Regenerating a file that has already been published changes that hash: on an
 * existing database, Drizzle no longer recognises anything, replays the CREATE
 * TABLEs and fails. The only way out then becomes deleting the database — and
 * with it the operator accounts and the pairings.
 *
 * This module freezes the fingerprints of the published files so that the
 * regression is caught at generation time, not at the startup of a hub that held
 * data.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SETS = ['hub', 'client']
const fingerprintFile = (set) => join(root, 'migrations', set, 'fingerprints.json')

const fingerprint = (content) => createHash('sha256').update(content).digest('hex')

/** Migrations present on disk, by tag, in order. */
export function migrations(set) {
  const folder = join(root, 'migrations', set)
  if (!existsSync(folder)) return {}
  return Object.fromEntries(
    readdirSync(folder)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => [name.replace(/\.sql$/, ''), fingerprint(readFileSync(join(folder, name)))]),
  )
}

export function sealed(set) {
  const path = fingerprintFile(set)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
}

/**
 * Compares the disk with the seal. A new migration is normal; a published
 * migration whose content has changed, or which has disappeared, is not.
 */
export function verify(set) {
  const onDisk = migrations(set)
  const expected = sealed(set)
  const anomalies = []

  for (const [tag, hash] of Object.entries(expected)) {
    if (!(tag in onDisk)) anomalies.push({ tag, problem: 'supprimée' })
    else if (onDisk[tag] !== hash) anomalies.push({ tag, problem: 'modifiée' })
  }
  const added = Object.keys(onDisk).filter((tag) => !(tag in expected))
  return { anomalies, added }
}

export function seal(set) {
  const onDisk = migrations(set)
  writeFileSync(fingerprintFile(set), `${JSON.stringify(onDisk, null, 2)}\n`)
  return onDisk
}
