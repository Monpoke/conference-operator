import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { ulid } from 'ulid'

/**
 * The machine's durable identity (the device flow's `client_id`).
 *
 * Deliberately outside the SQLite database: it must survive a reset of the local
 * cache, otherwise the machine would demand a new pairing on every incident — and
 * an operator would have to be called back in the middle of the day.
 */
export function loadOrCreateClientId(path: string): string {
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim()
    if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(existing)) return existing
  }
  const identifier = ulid()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, identifier, 'utf8')
  return identifier
}
