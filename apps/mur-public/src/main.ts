import { loadConfig } from './config.js'
import { startMurPublic } from './server.js'

const running = await startMurPublic(loadConfig())

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void running.close().then(() => process.exit(0))
  })
}
