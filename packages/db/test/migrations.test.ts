import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getTableName } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterAll, describe, expect, it } from 'vitest'

import { openDatabase, type SqliteDatabase } from '../src/index.js'
import { ingestEvent, room, hubSchema } from '../src/hub/index.js'
import { outbox, clientSchema } from '../src/client/index.js'

const migrationsRoot = fileURLToPath(new URL('../migrations', import.meta.url))
const tempDirs: string[] = []

function freshDb(kind: 'hub' | 'client', path = ':memory:'): SqliteDatabase {
  const db = openDatabase({ path })
  migrate(drizzle(db), { migrationsFolder: join(migrationsRoot, kind) })
  return db
}

function tempFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cloudnord-db-'))
  tempDirs.push(dir)
  return join(dir, name)
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('migrations', () => {
  it('crée toutes les tables du hub', () => {
    const db = freshDb('hub')
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_\\_%' ESCAPE '\\'")
      .all()
      .map((row) => (row as { name: string }).name)
    for (const table of Object.values(hubSchema)) {
      expect(tables).toContain(getTableName(table))
    }
    db.close()
  })

  it('crée toutes les tables du client', () => {
    const db = freshDb('client')
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_\\_%' ESCAPE '\\'")
      .all()
      .map((row) => (row as { name: string }).name)
    for (const table of Object.values(clientSchema)) {
      expect(tables).toContain(getTableName(table))
    }
    db.close()
  })

  it('est rejouable : une seconde migration ne casse rien', () => {
    const path = tempFile('replay.db')
    const first = freshDb('hub', path)
    first.close()
    // Rejouer sur une base déjà migrée doit être un no-op, pas une erreur.
    const second = openDatabase({ path })
    expect(() =>
      migrate(drizzle(second), { migrationsFolder: join(migrationsRoot, 'hub') }),
    ).not.toThrow()
    second.close()
  })

  it('active WAL sur une base fichier', () => {
    const db = openDatabase({ path: tempFile('wal.db') })
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    db.close()
  })
})

describe('idempotence de l\'ingestion (hub)', () => {
  it('rejette un rejeu du même événement pour la même salle', () => {
    const db = freshDb('hub')
    const orm = drizzle(db, { schema: hubSchema })
    orm.insert(room).values({
      id: 'track-1',
      name: 'Track 1',
      trackId: 'track-1',
      configJson: '{}',
    }).run()

    const event = {
      roomId: 'track-1',
      id: '01JB2ZK5T7QW9V0YHRXM3N4P6C',
      seq: 1,
      type: 'recording.started',
      delivery: 'required',
      occurredAt: '2026-10-30T09:00:00.000Z',
      monotonicMs: 1000,
      payloadJson: '{}',
    }

    orm.insert(ingestEvent).values(event).run()
    // Rejeu après reconnexion : la contrainte doit tenir, pas dupliquer.
    expect(() => orm.insert(ingestEvent).values(event).run()).toThrow(/UNIQUE|PRIMARY/i)

    // Un rejeu explicitement ignoré est la voie normale côté hub.
    expect(() =>
      orm.insert(ingestEvent).values(event).onConflictDoNothing().run(),
    ).not.toThrow()
    expect(orm.select().from(ingestEvent).all()).toHaveLength(1)
    db.close()
  })

  it('autorise le même id d\'événement dans deux salles différentes', () => {
    const db = freshDb('hub')
    const orm = drizzle(db, { schema: hubSchema })
    for (const id of ['track-1', 'track-2']) {
      orm.insert(room).values({
        id, name: id, trackId: id, configJson: '{}',
      }).run()
    }
    const base = {
      id: '01JB2ZK5T7QW9V0YHRXM3N4P6C',
      seq: 1,
      type: 'scene.changed',
      delivery: 'required',
      occurredAt: '2026-10-30T09:00:00.000Z',
      monotonicMs: 1000,
      payloadJson: '{}',
    }
    orm.insert(ingestEvent).values({ ...base, roomId: 'track-1' }).run()
    expect(() => orm.insert(ingestEvent).values({ ...base, roomId: 'track-2' }).run()).not.toThrow()
    db.close()
  })

  it('refuse un événement rattaché à une salle inconnue', () => {
    const db = freshDb('hub')
    const orm = drizzle(db, { schema: hubSchema })
    expect(() =>
      orm.insert(ingestEvent).values({
        roomId: 'salle-fantome',
        id: '01JB2ZK5T7QW9V0YHRXM3N4P6C',
        seq: 1,
        type: 'incident',
        delivery: 'required',
        occurredAt: '2026-10-30T09:00:00.000Z',
        monotonicMs: 1,
        payloadJson: '{}',
      }).run(),
    ).toThrow(/FOREIGN KEY/i)
    db.close()
  })
})

describe('collapse de l\'outbox (client)', () => {
  const entry = (id: string, dedupKey: string | null, seq: number) => ({
    id,
    roomId: 'track-1',
    seq,
    type: 'room.heartbeat',
    delivery: 'best-effort',
    payloadJson: '{}',
    occurredAt: '2026-10-30T09:00:00.000Z',
    monotonicMs: seq * 1000,
    dedupKey,
  })

  it('n\'accepte qu\'une entrée en attente par clé de collapse', () => {
    const db = freshDb('client')
    const orm = drizzle(db, { schema: clientSchema })
    orm.insert(outbox).values(entry('01AAAAAAAAAAAAAAAAAAAAAAAA', 'heartbeat:track-1', 1)).run()
    // Une heure hors-ligne ne doit pas accumuler 720 heartbeats.
    expect(() =>
      orm.insert(outbox).values(entry('01BBBBBBBBBBBBBBBBBBBBBBBB', 'heartbeat:track-1', 2)).run(),
    ).toThrow(/UNIQUE/i)
    db.close()
  })

  it('laisse passer les événements sans clé de collapse', () => {
    const db = freshDb('client')
    const orm = drizzle(db, { schema: clientSchema })
    // SQLite considère les NULL comme distincts : les événements `required`,
    // qui n'ont pas de dedupKey, s'accumulent normalement.
    orm.insert(outbox).values(entry('01CCCCCCCCCCCCCCCCCCCCCCCC', null, 1)).run()
    expect(() =>
      orm.insert(outbox).values(entry('01DDDDDDDDDDDDDDDDDDDDDDDD', null, 2)).run(),
    ).not.toThrow()
    expect(orm.select().from(outbox).all()).toHaveLength(2)
    db.close()
  })
})
