import type { FastifyServerOptions } from 'fastify'

/**
 * The hub's log lines, in the montage worker's shape (`apps/vod-montage/src/main.ts`):
 *
 *   {"time":"2026-10-01T07:00:33.588Z","level":"info","msg":"…",…}
 *
 * An ISO instant rather than pino's epoch milliseconds, a level label rather
 * than its number, and no `pid`/`hostname` — the pod already says which one it
 * is. Two processes that run side by side read the same way, and one query
 * covers both.
 *
 * `time` first takes a detour. Pino writes the level, then the timestamp
 * fragment, then the rest, and caches the level part per level — a time put
 * there would freeze on the first line. So the level part is left empty, the
 * timestamp fragment carries `"time"` without the leading comma pino would
 * otherwise need, and the label comes back through the mixin, evaluated on
 * every line. `log-format.test.ts` parses the output: a pino that changes how
 * it joins these pieces fails there, not in production.
 */
export function hubLoggerOptions(level: string): Exclude<FastifyServerOptions['logger'], boolean | undefined> {
  return {
    level,
    base: null,
    timestamp: () => `"time":"${new Date().toISOString()}"`,
    formatters: { level: () => ({}) },
    mixin: (_merge, levelNumber, logger) => ({ level: logger.levels.labels[levelNumber] }),
    // The label stays where the mixin put it, and stays the label: a context
    // object carrying its own `level` field does not get to rewrite it.
    mixinMergeStrategy: (merge, mixin) => Object.assign(mixin, merge, { level: (mixin as { level: string }).level }),
  }
}
