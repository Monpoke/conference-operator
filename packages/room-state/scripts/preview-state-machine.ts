/**
 * Writes the state machine test bench, with a real program inside.
 *
 * By default the Cloud Nord 2026 export that also backs the tests: the schedule
 * played out there is the one from the day itself, shared breaks included.
 *
 *     pnpm --filter @conference-operator/room-state preview [directory] [path/export.json]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applySharedBreaks, normalizeProgram, sessionsForRoom } from '@conference-operator/program'
import { renderStateMachinePage, type RoomPreview } from '../src/state-machine-page.js'

const outDir = resolve(process.argv[2] ?? './preview')
const source =
  process.argv[3] ??
  fileURLToPath(new URL('../../program/test/fixtures/cloudnord-2026.json', import.meta.url))

/**
 * Shared breaks applied, the way the hub serves them.
 *
 * Without them, a room with no lunch in its program would stay "hors créneau"
 * while the others are on a break — and we would look for the fault in the state
 * machine when it is in the program we hand it.
 */
const program = applySharedBreaks(normalizeProgram(JSON.parse(readFileSync(source, 'utf8'))))

const rooms: RoomPreview[] = program.rooms.map((room) => ({
  id: room.id,
  name: room.name,
  slots: sessionsForRoom(program, room.id).map((session) => ({
    id: session.id,
    title: session.title,
    kind: session.kind,
    startsAt: session.startsAt,
    startsAtMs: session.startsAtMs,
    endsAt: session.endsAt,
    endsAtMs: session.endsAtMs,
    durationMinutes: session.durationMinutes,
  })),
}))

if (rooms.length === 0) throw new Error(`No room in ${source}`)

const html = renderStateMachinePage({
  rooms,
  timezone: program.timezone,
  eventName: program.event.name,
  // Half an hour before the first slot: the page opens on "hors créneau", and
  // you watch the day start rather than catching it halfway through.
  startAt: (rooms[0]!.slots[0]?.startsAtMs ?? Date.now()) - 30 * 60_000,
})

mkdirSync(outDir, { recursive: true })
const path = join(outDir, 'state-machine.html')
writeFileSync(path, html)
console.log(`wrote ${path}`)
console.log(`  ${rooms.length} rooms · ${program.sessions.length} slots · ${program.timezone}`)
