/**
 * The montage worker: asks the hub for a talk, edits it, sends it back, again.
 *
 *   HUB_URL=https://hub.cloudnord.fr HUB_WORKER_TOKEN=wt_… pnpm start
 *
 * One job at a time: rendering and encoding already use every core, and two
 * at once would only make both late. For more throughput, run more workers.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { launchChrome, type Chrome } from './chrome.js'
import { loadConfig } from './config.js'
import { connectHub } from './hub.js'
import { processJob, type Log } from './worker.js'

const log: Log = (level, message, context) => {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg: message, ...context })
  if (level === 'error') console.error(line)
  else console.log(line)
}

const config = loadConfig()
const hub = connectHub(config.hubUrl, config.workerToken)
await mkdir(config.workDir, { recursive: true })

let stopping = false
let wake: (() => void) | null = null
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // The job in hand is finished — its lease would otherwise hold it ten
    // minutes for nobody. A second signal stops at once.
    if (stopping) process.exit(1)
    stopping = true
    log('info', 'arrêt demandé : fin du montage en cours, puis arrêt')
    wake?.()
  })
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    wake = () => {
      clearTimeout(timer)
      resolve()
    }
  })

let chrome: Chrome | null = null
let profile: string | null = null
async function browser(): Promise<Chrome> {
  if (chrome != null) return chrome
  profile = await mkdtemp(join(config.workDir, 'chrome-'))
  chrome = await launchChrome(config.chrome, profile)
  return chrome
}
async function closeBrowser(): Promise<void> {
  await chrome?.stop().catch(() => undefined)
  if (profile != null) await rm(profile, { recursive: true, force: true })
  chrome = null
  profile = null
}

log('info', 'worker de montage démarré', { hub: config.hubUrl, jingle: config.jingle ?? null })

while (!stopping) {
  let claim
  try {
    claim = await hub.montage.claim()
  } catch (error) {
    log('warn', 'hub injoignable ou jeton refusé', { error: error instanceof Error ? error.message : String(error) })
    await sleep(config.pollSeconds * 1000)
    continue
  }
  if (claim == null) {
    await sleep(config.pollSeconds * 1000)
    continue
  }
  log('info', 'montage pris', { jobId: claim.jobId, sessionId: claim.sessionId, titre: claim.habillage.talk.title })
  try {
    await processJob({ hub, claim, config, chrome: await browser(), log })
  } catch (error) {
    // A browser that crashed is started again for the next job.
    log('error', 'erreur hors job : navigateur relancé', { error: error instanceof Error ? error.message : String(error) })
    await closeBrowser()
  }
}

await closeBrowser()
log('info', 'worker arrêté')
