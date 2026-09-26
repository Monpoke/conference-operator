import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { MontageClaim, MontageEtape, Sidecar, VodHabillage } from '@conference-operator/contract'
import type { Chrome } from './chrome.js'
import type { Config } from './config.js'
import type { Hub } from './hub.js'
import { takeFiles } from './montage.js'
import { analyser } from './analyse.js'
import { makeApercus, uploadApercus } from './apercus.js'
import { monter } from './pipeline.js'
import { download, uploadParts } from './transfer.js'

export type Log = (level: 'info' | 'warn' | 'error', message: string, context?: object) => void

/** The console cancelled the job: stop, and say nothing more to the hub about it. */
export class Cancelled extends Error {
  constructor() {
    super('montage annulé depuis la console')
    this.name = 'Cancelled'
  }
}

/** A heartbeat every minute, well inside the hub's ten-minute lease. */
const HEARTBEAT_MS = 60_000

/**
 * One job, from the claim to the edited video in the storage.
 *
 * Everything the worker does is reported as a step and a percentage, which the
 * heartbeat carries: the console shows where each talk stands, and the hub
 * knows the worker is alive.
 */
export async function processJob(options: {
  hub: Hub
  claim: MontageClaim
  config: Config
  chrome: Chrome
  log: Log
}): Promise<void> {
  const { hub, claim, config, log } = options
  const jobDir = join(config.workDir, claim.jobId)
  await mkdir(jobDir, { recursive: true })

  let etape: MontageEtape = 'telechargement'
  let pourcent = 0
  let cancelled = false
  const beat = async () => {
    try {
      const answer = await hub.montage.heartbeat({ jobId: claim.jobId, etape, pourcent })
      if (answer.annule) cancelled = true
    } catch (error) {
      log('warn', 'battement refusé par le hub', { jobId: claim.jobId, error: message(error) })
    }
  }
  const report = (next: MontageEtape, fraction: number) => {
    const changed = next !== etape
    etape = next
    pourcent = Math.round(Math.min(1, Math.max(0, fraction)) * 100)
    if (changed) void beat()
    if (cancelled) throw new Cancelled()
  }
  const timer = setInterval(() => void beat(), HEARTBEAT_MS)

  try {
    // The sidecar first: it names the files and holds the marks.
    const sidecarFile = join(jobDir, 'sidecar.json')
    await download(claim.sidecarUrl, sidecarFile)
    const sidecar = JSON.parse(await readFile(sidecarFile, 'utf8')) as Sidecar
    const names = takeFiles(sidecar).map((f) => f.file)

    const { urls, manquants } = await hub.montage.fichiers({ jobId: claim.jobId, files: names })
    if (manquants.length > 0) {
      log('info', 'rush pas encore dans le stockage : job rendu, repris plus tard', { jobId: claim.jobId, manquants })
      await hub.montage.fail({ jobId: claim.jobId, raison: `en attente de : ${manquants.join(', ')}`, reessayer: true })
      return
    }
    for (const [index, { file, url }] of urls.entries()) {
      // The sidecar's names, kept: the assembly reads them from its segments.
      if (basename(file) !== file) throw new Error(`nom de fichier inattendu dans le sidecar : ${file}`)
      await download(url, join(jobDir, file))
      report('telechargement', (index + 1) / urls.length)
    }

    // First the analysis: where to cut, how loud, and what the console shows of
    // it. Through to the montage only if the hub says so.
    let coupe = claim.coupe
    if (claim.phase === 'analyse') {
      report('analyse', 0)
      const analysed = await analyser({
        sidecar, folder: jobDir, audio: config.audio, scratchDir: jobDir, regie: claim.regie,
        log: (text) => log('info', text, { jobId: claim.jobId }),
      })
      const apercusDir = join(jobDir, 'apercus')
      await mkdir(apercusDir, { recursive: true })
      const noms = await makeApercus({
        segments: analysed.segments, takeMs: analysed.takeMs, hasAudio: analysed.hasAudio, coupe: analysed.coupe, dir: apercusDir,
        log: (text) => log('warn', text, { jobId: claim.jobId }),
      })
      if (noms.length > 0) await uploadApercus(apercusDir, await hub.montage.artefacts({ jobId: claim.jobId, noms }))
      report('analyse', 1)
      const next = await hub.montage.analyseTerminee({
        jobId: claim.jobId,
        proposition: analysed.coupe,
        confiance: analysed.confiance,
        raisons: analysed.raisons.map((raison) => raison.slice(0, 300)),
        audio: analysed.audio,
        takeMs: Math.max(1, Math.round(analysed.takeMs)),
        artefacts: noms,
      })
      if (next.suite === 'validation') {
        log('info', 'coupe à valider dans la console', { jobId: claim.jobId, confiance: analysed.confiance })
        return
      }
      coupe = next.coupe
    }
    if (coupe == null) throw new Error('montage sans coupe validée : le hub n’en a pas transmis')

    const output = join(jobDir, 'montage.mp4')
    const result = await monter({
      coupe,
      chrome: options.chrome,
      habillage: completeFromSidecar(claim.habillage, sidecar),
      sidecar,
      folder: jobDir,
      jingle: config.jingle ?? null,
      audio: config.audio,
      workDir: jobDir,
      output,
      onStep: report,
      log: (text) => log('info', text, { jobId: claim.jobId }),
    })
    report('envoi', 0)
    if (cancelled) throw new Cancelled()

    const { size } = await stat(output)
    const plan = await hub.montage.envoi({ jobId: claim.jobId, sizeBytes: size })
    const parts = await uploadParts(output, {
      partSize: plan.taillePartOctets,
      parts: plan.parts,
      sign: (numeros) => hub.montage.parts({ jobId: claim.jobId, numeros }),
    }, { concurrency: config.uploadConcurrency, onProgress: (fraction) => report('envoi', fraction) })

    const { objectKey } = await hub.montage.complete({
      jobId: claim.jobId,
      parts,
      durationMs: result.durationMs,
      marquesManquantes: result.missingMarks,
      coupe: result.coupe,
      audio: result.audio,
    })
    log('info', 'montage envoyé', { jobId: claim.jobId, objectKey, minutes: +(result.durationMs / 60_000).toFixed(1) })
  } catch (error) {
    if (error instanceof Cancelled) {
      log('info', 'montage annulé depuis la console', { jobId: claim.jobId })
      return
    }
    log('error', 'montage échoué', { jobId: claim.jobId, error: message(error) })
    await hub.montage.fail({ jobId: claim.jobId, raison: message(error), reessayer: false }).catch(() => undefined)
  } finally {
    clearInterval(timer)
    await rm(jobDir, { recursive: true, force: true })
  }
}

/**
 * The hub's content, completed from the take where the program knew nothing.
 *
 * A talk added on the day — a lightning talk, a replacement — is in no
 * program: the hub sends an empty title, the sidecar has what the room showed.
 */
export function completeFromSidecar(habillage: VodHabillage, sidecar: Pick<Sidecar, 'title' | 'speakers' | 'category'>): VodHabillage {
  return {
    ...habillage,
    talk: {
      ...habillage.talk,
      title: habillage.talk.title || sidecar.title,
      category: habillage.talk.category ?? sidecar.category,
    },
    speakers: habillage.speakers.length > 0
      ? habillage.speakers
      : sidecar.speakers.slice(0, 6).map((s) => ({ name: s.name, company: s.company, photoUrl: null })),
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
