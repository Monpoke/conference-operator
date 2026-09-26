import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { hubSettingsSchema, resolveEventIdentity, type Boucle } from '@conference-operator/contract'
import { programSchema, type Program } from '@conference-operator/program'

export interface HubData {
  program: Program | null
  boucle: Boucle
  eventName: string | null
  /** An image's local file when the hub holds it, its address otherwise. */
  localize: (ref: string | null) => string | null
}

/**
 * What a hub knows, read from its data folder — for rendering on the machine
 * the hub runs on, with the console's settings, before any worker exists.
 *
 * Read-only, and through Node's own SQLite: the hub may be running, and the
 * CLI must not bring a native module of its own for one query.
 */
export function readHubData(folder: string): HubData {
  const db = new DatabaseSync(join(folder, 'hub.db'), { readOnly: true })
  try {
    const settingsRow = db.prepare("SELECT value_json FROM hub_setting WHERE key = 'hub'").get() as { value_json: string } | undefined
    const settings = hubSettingsSchema.parse(settingsRow == null ? {} : JSON.parse(settingsRow.value_json))
    const programRow = db.prepare('SELECT program_json FROM program_snapshot WHERE active = 1').get() as { program_json: string } | undefined
    const program = programRow == null ? null : (programSchema.parse(JSON.parse(programRow.program_json)) as Program)
    const identity = resolveEventIdentity({
      setting: { name: settings.eventName, shortName: settings.eventShortName },
      program: program?.event.name ?? null,
    })
    const assets = join(folder, 'assets')
    return {
      program,
      boucle: settings.boucle,
      eventName: identity.name,
      // The asset store's own naming: the reference's hash, its extension.
      localize: (ref) => {
        if (ref == null) return null
        const file = join(assets, createHash('sha256').update(ref).digest('hex') + extensionOf(ref))
        if (existsSync(file)) return file
        return /^https?:\/\//.test(ref) ? ref : null
      },
    }
  } finally {
    db.close()
  }
}

function extensionOf(ref: string): string {
  try {
    const extension = extname(new URL(ref).pathname).toLowerCase()
    return /^\.[a-z0-9]{2,5}$/.test(extension) ? extension : ''
  } catch {
    return ''
  }
}
