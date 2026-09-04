/**
 * Runs a room **without Electron**.
 *
 * All the client's logic lives in `core/` and does not depend on Electron: one can
 * therefore start a complete room and open its pages in a browser. Useful to
 * develop on a machine with no graphical interface — WSL, a container, a remote
 * server — and to observe the chain without setting up a physical control room.
 *
 *   HUB_ORIGIN=http://localhost:8787 pnpm dev:headless
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { RoomApp } from '../src/core/room-app.js'
import { createMockObsTransport } from '../src/core/obs-mock.js'
import { modeOffset, readMode } from '../src/core/mode.js'
import { formatLogLine } from '../src/core/console-log.js'

const hubOrigin = process.env.HUB_ORIGIN ?? 'http://localhost:8787'
const dataDir = resolve(process.env.DATA_DIR ?? './.local-data')
const port = Number(process.env.DISPLAY_PORT ?? 7788)

/**
 * This script serves development: it puts itself in that mode.
 *
 * Without this default, one would have to write `MODE=dev` in front of every
 * launch to get what this script alone knows how to do. `MODE=production` stays
 * possible, and it is then a real room with no Electron — a real case on a machine
 * with no graphical interface.
 *
 * The local simulated time serves to develop **with no hub**: as soon as a hub
 * answers, it is its time that wins. To run through an event day, set
 * `SIMULATED_TIME` on the hub rather than here — otherwise the two clocks diverge
 * and everything that compares them starts lying.
 */
const mode = readMode({ MODE: 'dev', ...process.env })
for (const { variable, reason } of mode.ignores) {
  console.error(formatLogLine('error', `${variable} ignoré : ${reason}`))
}
const offset = modeOffset(mode)

mkdirSync(dataDir, { recursive: true })

/** The machine's identity, kept between two launches. */
const clientIdPath = join(dataDir, 'client-id')
const clientId = existsSync(clientIdPath)
  ? readFileSync(clientIdPath, 'utf8').trim()
  : (() => {
      const fresh = ulid()
      writeFileSync(clientIdPath, fresh)
      return fresh
    })()

/** The token in clear: this is a development environment, and we say so. */
const tokenPath = join(dataDir, 'jeton')

const room = new RoomApp({
  dataDir,
  mode: mode.mode,
  // `ROOM_ID` short-circuits the choice screen, for a provisioned machine.
  roomId: process.env.ROOM_ID,
  // Fill in to develop the rebuilt control app with hot reloading:
  // REGIE_VITE_ORIGIN=http://127.0.0.1:5174, with `pnpm --filter @cloudnord/control-web dev` alongside.
  regieViteOrigin: process.env.REGIE_VITE_ORIGIN ?? null,
  hubOrigin,
  clientId,
  displayPort: port,
  readToken: () => (existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : null),
  writeToken: (token) => writeFileSync(tokenPath, token),
  obsTransportFactory: !mode.obsSimulated
    ? undefined
    : (instance, scenes) =>
        createMockObsTransport({
          instance,
          // The scenes the room configured: a simulated OBS that did not have them
          // would make every slightly personal name come out as "role not found",
          // red, on an instance that does not exist.
          scenes,
          recordingDir: join(dataDir, 'enregistrements'),
          onLog: (message) => console.log(formatLogLine('info', message)),
        }),
  onLog: (level, message, context) => console.log(formatLogLine(level, message, context)),
  onPairingCode: (code) => {
    console.log('')
    console.log('  ┌─────────────────────────────────────────────┐')
    console.log(`  │  Code d'appairage :  ${code.user_code.padEnd(22)}│`)
    console.log('  └─────────────────────────────────────────────┘')
    console.log(`  À saisir dans la console : ${hubOrigin}/admin`)
    console.log('')
  },
})

// The local simulated time: an offset, like the one the hub will set.
if (offset !== 0) room.runtime.setClockOffset(offset, true)

const local = await room.startDisplay()

console.log('')
console.log(`  Salle démarrée — machine ${clientId}`)
console.log(`  Régie       ${local}/regie`)
console.log(`  Projection  ${local}/display/projector`)
console.log(`  Habillage   ${local}/display/overlay`)
console.log(`  Mode        ${mode.mode}`)
console.log(`  OBS         ${mode.obsSimulated ? 'SIMULÉ' : 'réel (obs-websocket)'}`)
console.log('')

if (offset !== 0) {
  console.log(`  Heure simulée localement : ${new Date(room.runtime.correctedNow()).toISOString()}`)
  console.log("  (l'heure du hub l'emportera dès la connexion)")
}

// Watching the hub: a hub absent at startup does not condemn the room, it will
// join as soon as it answers.
room.startSupervision()

const token = await room.ensurePaired()
if (token == null) {
  console.log('  Hub injoignable — la salle tourne sur son cache local et réessaiera.')
} else {
  await room.connectHub(token)
  await room.connectObs()
  room.runtime.refreshSessions()
  console.log('  Hub connecté, OBS connecté.')
  const state = room.runtime.state()
  if (state.simulatedClock) {
    console.log('  Horloge du hub : SIMULÉE')
  }
  console.log(`  Talk en cours : ${state.currentSession?.title ?? 'aucun'}`)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void room.close().then(() => process.exit(0))
  })
}
