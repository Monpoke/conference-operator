import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { ulid } from 'ulid'

/**
 * Identité durable de la machine (`client_id` du flux device).
 *
 * Volontairement hors de la base SQLite : elle doit survivre à une remise à
 * zéro du cache local, sinon la machine réclamerait un nouvel appairage à
 * chaque incident — et il faudrait rappeler un opérateur en pleine journée.
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
