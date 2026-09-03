import { loadConfig } from './config.js'
import { createHub } from './server.js'

const config = loadConfig()
const hub = await createHub(config)

/**
 * Program source: the setting is authoritative, the environment seeds it.
 *
 * `PROGRAM_SOURCE_URL` only serves the very first startup, when the database is
 * empty. After that the console decides: a URL corrected during the event must
 * survive the restart that follows, and a frozen `.env` would overwrite it every
 * time.
 */
const settings = hub.services.settings.get()
const programSource = settings.programSourceUrl ?? config.programSourceUrl ?? null
if (settings.programSourceUrl == null && programSource != null) {
  hub.services.settings.update({ programSourceUrl: programSource })
}

if (programSource != null && hub.services.programs.active() == null) {
  // First startup: a hub with no program is useless, so import it right away
  // rather than waiting for a manual action in the admin console.
  const snapshot = await hub.services.programs.importFrom(programSource)
  const { created } = hub.services.rooms.ensureFromTracks(snapshot.program.rooms)
  hub.app.log.info(
    {
      contentHash: snapshot.contentHash,
      sessions: snapshot.program.sessions.length,
      sallesCreees: created,
    },
    'programme importé au démarrage',
  )
}

try {
  await hub.app.listen({ port: config.port, host: config.host })
} catch (cause) {
  // An explicit message rather than an `EADDRINUSE` trace: in development, the
  // cause is almost always a previous instance still running.
  if ((cause as { code?: string }).code === 'EADDRINUSE') {
    console.error(
      `Le port ${config.port} est déjà utilisé — une autre instance du hub tourne probablement.\n` +
        `Arrêtez-la, ou lancez sur un autre port : PORT=8788 pnpm dev`,
    )
    process.exit(1)
  }
  throw cause
}

/**
 * Clean shutdown.
 *
 * Two levels, because one is not enough:
 *
 * - **Graceful**, on SIGINT/SIGTERM: drains the requests in flight, cuts the
 *   WebSockets, closes the database. That is the normal path, the one of
 *   `pnpm start` and of production.
 * - **Synchronous**, on `exit`: `tsx watch` — so `pnpm dev` — kills the process
 *   without letting the asynchronous work finish, on every Ctrl-C **and on every
 *   file save**. Without this safety net, the database would never be closed
 *   properly in development.
 *
 * `SIGKILL` stays out of reach: nothing can intercept it, and SQLite's WAL mode
 * exists precisely for that case.
 */
process.on('exit', () => hub.closeSync())

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    /**
     * Deadline on the graceful shutdown.
     *
     * A request that never finishes would leave the process alive indefinitely.
     * Past this delay we exit: the `exit` handler above closes the database on
     * the way out.
     */
    const deadline = setTimeout(() => {
      console.error("Arrêt gracieux trop long — fermeture forcée")
      process.exit(1)
    }, 5_000)
    deadline.unref()

    void hub
      .close()
      .catch((cause: Error) => console.error("Erreur pendant l'arrêt :", cause.message))
      .finally(() => process.exit(0))
  })
}
