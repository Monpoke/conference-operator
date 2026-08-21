import { loadConfig } from './config.js'
import { createHub } from './server.js'

const config = loadConfig()
const hub = await createHub(config)

if (config.programSourceUrl != null && hub.services.programs.active() == null) {
  // Premier démarrage : un hub sans programme ne sert à rien, autant l'importer
  // tout de suite plutôt que d'attendre une action manuelle dans l'admin.
  const snapshot = await hub.services.programs.importFrom(config.programSourceUrl)
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
  // Message explicite plutôt qu'une trace `EADDRINUSE` : en développement, la
  // cause est presque toujours une instance précédente encore ouverte.
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
 * Arrêt propre.
 *
 * Deux niveaux, parce qu'un seul ne suffit pas :
 *
 * - **Gracieux**, sur SIGINT/SIGTERM : draine les requêtes en cours, coupe les
 *   WebSockets, referme la base. C'est le chemin normal, celui de `pnpm start`
 *   et de la production.
 * - **Synchrone**, sur `exit` : `tsx watch` — donc `pnpm dev` — coupe le
 *   processus sans laisser l'asynchrone se terminer, à chaque Ctrl-C **et à
 *   chaque sauvegarde de fichier**. Sans ce filet, la base ne serait jamais
 *   refermée proprement en développement.
 *
 * `SIGKILL` reste hors de portée : rien ne peut l'intercepter, et le mode WAL
 * de SQLite est précisément fait pour ce cas.
 */
process.on('exit', () => hub.closeSync())

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    /**
     * Échéance sur l'arrêt gracieux.
     *
     * Une requête qui ne se termine pas laisserait le processus vivant
     * indéfiniment. Passé ce délai, on sort : le gestionnaire `exit` ci-dessus
     * referme la base au passage.
     */
    const echeance = setTimeout(() => {
      console.error("Arrêt gracieux trop long — fermeture forcée")
      process.exit(1)
    }, 5_000)
    echeance.unref()

    void hub
      .close()
      .catch((cause: Error) => console.error("Erreur pendant l'arrêt :", cause.message))
      .finally(() => process.exit(0))
  })
}
