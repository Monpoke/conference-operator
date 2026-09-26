import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { readHubData } from '../src/cli/hub-data.js'

let dir: string
afterEach(() => rm(dir, { recursive: true, force: true }))

/** A hub folder reduced to what the CLI reads: the settings row, the images. */
async function hubFolder(settings: object | null): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'hub-data-'))
  await mkdir(join(dir, 'assets'))
  const db = new DatabaseSync(join(dir, 'hub.db'))
  db.exec('CREATE TABLE hub_setting (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT)')
  db.exec('CREATE TABLE program_snapshot (program_json TEXT NOT NULL, active INTEGER NOT NULL)')
  if (settings != null) db.prepare("INSERT INTO hub_setting (key, value_json) VALUES ('hub', ?)").run(JSON.stringify(settings))
  db.close()
  return dir
}

describe('a hub’s folder', () => {
  it('gives the loop’s logo set in the console, from the hub’s own images', async () => {
    const folder = await hubFolder({ boucle: { logo: `hub-image:${'a'.repeat(64)}.png` }, eventName: 'Cloud Nord 2026' })
    const file = join(folder, 'assets', createHash('sha256').update(`hub-image:${'a'.repeat(64)}.png`).digest('hex') + '.png')
    await writeFile(file, 'png')

    const hub = readHubData(folder)
    expect(hub.boucle.logo).toBe(`hub-image:${'a'.repeat(64)}.png`)
    expect(hub.localize(hub.boucle.logo)).toBe(file)
    expect(hub.eventName).toBe('Cloud Nord 2026')
    expect(hub.program).toBeNull()
  })

  it('falls back on the address for an image it does not hold, and on nothing for a console one', async () => {
    const hub = readHubData(await hubFolder(null))
    expect(hub.boucle.logo).toBeNull()
    expect(hub.localize('https://exemple.fr/logo.png')).toBe('https://exemple.fr/logo.png')
    expect(hub.localize('hub-image:absent.png')).toBeNull()
  })
})
