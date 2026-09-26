import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm'
import { ulid } from 'ulid'
import type {
  MontageClaim,
  MontageEtape,
  MontageJobView,
  MontageState,
  MontageWorkerView,
  SignedPart,
  VodHabillage,
} from '@conference-operator/contract'
import { montageJob, montageWorker } from '@conference-operator/db/hub'
import type { HubDatabase } from '../db.js'
import type { VodService } from './vod.js'

/**
 * The montage queue, and the workers allowed to take from it.
 *
 * The hub decides what is edited and holds the storage keys; a worker, hosted
 * wherever there is CPU to spare, takes a job, gets signed addresses for that
 * take only, renders, uploads, and says so. Nothing is pushed to a worker: it
 * asks. That is what lets it sit behind any NAT, and lets there be several.
 *
 * A job is held under a **lease** renewed by the worker's heartbeats. A worker
 * killed mid-render — a laptop closed, a container evicted — stops renewing, the
 * lease lapses, and the job goes back to the queue on the next claim.
 */

/** Long enough for the slowest step between two heartbeats — the assembly of an hour of video. */
export const LEASE_MS = 10 * 60_000
/** A rush still on its way: the job is offered again after this. */
export const RETRY_DELAY_MS = 10 * 60_000
/** Beyond this, a job that keeps killing its workers is failed, not retried forever. */
export const MAX_ATTEMPTS = 3
/** S3 caps a multipart at 10,000 parts; the part size grows with the file past that. */
const MIN_PART_BYTES = 16 * 1024 * 1024
const MAX_PARTS = 9_000

export class MontageError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'PRECONDITION_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'MontageError'
  }
}

export interface Worker {
  id: string
  nom: string
}

type JobRow = typeof montageJob.$inferSelect

export class MontageService {
  constructor(
    private readonly db: HubDatabase,
    /** `null` when no storage is configured: nothing can be edited then. */
    private readonly vod: () => VodService | null,
    /** What a talk's intro and outro show, resolved from the active program. */
    private readonly habillage: (sessionId: string) => VodHabillage,
    private readonly now: () => Date = () => new Date(),
    private readonly onLog: (level: 'info' | 'warn', message: string, context?: object) => void = () => {},
    /** The talk's title in the active program, for the console's list. */
    private readonly titleOf: (sessionId: string) => string | null = () => null,
  ) {}

  /* ---------- Workers ---------- */

  createWorker(nom: string, createdBy: string | null): MontageWorkerView & { token: string } {
    const token = `wt_${randomBytes(32).toString('base64url')}`
    const row = { id: ulid(), nom, tokenHash: hashToken(token), createdBy, createdAt: this.iso() }
    this.db.insert(montageWorker).values(row).run()
    return { id: row.id, nom, createdAt: row.createdAt, lastSeenAt: null, revokedAt: null, token }
  }

  workers(): MontageWorkerView[] {
    return this.db.select().from(montageWorker).orderBy(desc(montageWorker.createdAt)).all().map((row) => ({
      id: row.id,
      nom: row.nom,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      revokedAt: row.revokedAt,
    }))
  }

  /** Revokes a worker; the jobs it held go back to the queue at once. */
  revokeWorker(id: string): boolean {
    const done = this.db
      .update(montageWorker)
      .set({ revokedAt: this.iso(), tokenHash: null })
      .where(and(eq(montageWorker.id, id), isNull(montageWorker.revokedAt)))
      .run().changes > 0
    if (done) {
      this.db
        .update(montageJob)
        .set({ state: 'attente', workerId: null, leaseUntil: null, etape: null, pourcent: 0, updatedAt: this.iso() })
        .where(and(eq(montageJob.workerId, id), eq(montageJob.state, 'en-cours')))
        .run()
    }
    return done
  }

  fromToken(token: string): Worker | null {
    if (!token.startsWith('wt_')) return null
    const row = this.db
      .select()
      .from(montageWorker)
      .where(and(eq(montageWorker.tokenHash, hashToken(token)), isNull(montageWorker.revokedAt)))
      .get()
    if (row == null) return null
    this.db.update(montageWorker).set({ lastSeenAt: this.iso() }).where(eq(montageWorker.id, row.id)).run()
    return { id: row.id, nom: row.nom }
  }

  /* ---------- The queue ---------- */

  /**
   * Queues a take — called when its sidecar has arrived in the storage.
   *
   * One live job per talk: a later take (a talk restarted after a fire alarm)
   * replaces the one still waiting rather than editing both. A job already
   * being rendered is left to finish; the new take waits behind it.
   */
  enqueue(input: { sessionId: string; roomId: string; sidecarUploadId: string }): MontageJobView {
    const waiting = this.db
      .select()
      .from(montageJob)
      .where(and(eq(montageJob.sessionId, input.sessionId), eq(montageJob.state, 'attente')))
      .get()
    if (waiting != null) {
      this.db
        .update(montageJob)
        .set({ sidecarUploadId: input.sidecarUploadId, roomId: input.roomId, pasAvant: null, erreur: null, updatedAt: this.iso() })
        .where(eq(montageJob.id, waiting.id))
        .run()
      return this.view(this.job(waiting.id))
    }
    const row = {
      id: ulid(),
      sessionId: input.sessionId,
      roomId: input.roomId,
      sidecarUploadId: input.sidecarUploadId,
      state: 'attente',
      pourcent: 0,
      tentatives: 0,
      createdAt: this.iso(),
      updatedAt: this.iso(),
    }
    this.db.insert(montageJob).values(row).run()
    this.onLog('info', 'montage en file', { sessionId: input.sessionId, roomId: input.roomId })
    return this.view(this.job(row.id))
  }

  /** The next job for this worker, leased to it — or `null`. */
  claim(worker: Worker): MontageClaim | null {
    const vod = this.requireVod()
    this.expireLeases()
    const now = this.iso()
    const candidates = this.db
      .select()
      .from(montageJob)
      .where(eq(montageJob.state, 'attente'))
      .orderBy(montageJob.createdAt)
      .all()
      .filter((job) => job.pasAvant == null || job.pasAvant <= now)

    for (const job of candidates) {
      const sidecar = vod.upload(job.sidecarUploadId)
      if (sidecar == null || sidecar.state !== 'termine') {
        this.finish(job.id, 'echoue', 'le sidecar de la prise n’est plus dans le stockage')
        continue
      }
      const bail = new Date(this.now().getTime() + LEASE_MS).toISOString()
      // Conditional on the state: two workers claiming at once cannot both win.
      const taken = this.db
        .update(montageJob)
        .set({
          state: 'en-cours',
          workerId: worker.id,
          leaseUntil: bail,
          tentatives: job.tentatives + 1,
          etape: 'telechargement',
          pourcent: 0,
          erreur: null,
          updatedAt: now,
        })
        .where(and(eq(montageJob.id, job.id), eq(montageJob.state, 'attente')))
        .run().changes > 0
      if (!taken) continue
      this.onLog('info', 'montage pris', { jobId: job.id, sessionId: job.sessionId, worker: worker.nom })
      return {
        jobId: job.id,
        sessionId: job.sessionId,
        roomId: job.roomId,
        sidecarUrl: vod.presignGet(sidecar.objectKey),
        habillage: this.habillage(job.sessionId),
        bail,
      }
    }
    return null
  }

  /**
   * Read addresses for the take's files, named as the sidecar names them —
   * relative to the sidecar's own folder.
   */
  files(worker: Worker, jobId: string, names: string[]): { urls: { file: string; url: string }[]; manquants: string[] } {
    const vod = this.requireVod()
    const job = this.held(worker, jobId)
    const sidecar = vod.upload(job.sidecarUploadId)
    if (sidecar == null) throw new MontageError('NOT_FOUND', 'le sidecar de la prise a disparu du registre')
    const folder = folderOf(sidecar.file)
    const urls: { file: string; url: string }[] = []
    const manquants: string[] = []
    for (const name of names) {
      if (name.includes('..')) throw new MontageError('PRECONDITION_FAILED', `nom de fichier refusé : ${name}`)
      const row = vod.uploadedFile(job.roomId, folder + name)
      if (row == null || row.kind !== 'rush') manquants.push(name)
      else urls.push({ file: name, url: vod.presignGet(row.objectKey) })
    }
    return { urls, manquants }
  }

  heartbeat(worker: Worker, jobId: string, etape: MontageEtape, pourcent: number): { ok: boolean; annule: boolean; bail: string } {
    const job = this.job(jobId)
    if (job.workerId !== worker.id) throw new MontageError('CONFLICT', 'ce montage est tenu par un autre worker')
    const bail = new Date(this.now().getTime() + LEASE_MS).toISOString()
    if (job.state !== 'en-cours') return { ok: false, annule: job.state === 'annule', bail: job.leaseUntil ?? bail }
    this.db
      .update(montageJob)
      .set({ etape, pourcent, leaseUntil: bail, updatedAt: this.iso() })
      .where(eq(montageJob.id, jobId))
      .run()
    return { ok: true, annule: false, bail }
  }

  /** Opens the output's multipart, at the key beside the take's rushes. */
  async openUpload(worker: Worker, jobId: string, sizeBytes: number): Promise<{ taillePartOctets: number; parts: number }> {
    const vod = this.requireVod()
    const job = this.held(worker, jobId)
    const sidecar = vod.upload(job.sidecarUploadId)
    if (sidecar == null) throw new MontageError('NOT_FOUND', 'le sidecar de la prise a disparu du registre')
    // A retried upload leaves the previous multipart open: abandoned now, not billed until housekeeping.
    if (job.s3UploadId != null && job.outputKey != null) await vod.abortMultipart(job.outputKey, job.s3UploadId)
    const outputKey = vod.montageKeyFor(sidecar.objectKey)
    const s3UploadId = await vod.openMultipart(outputKey)
    this.db
      .update(montageJob)
      .set({ outputKey, s3UploadId, etape: 'envoi', pourcent: 0, updatedAt: this.iso() })
      .where(eq(montageJob.id, jobId))
      .run()
    const taillePartOctets = Math.max(MIN_PART_BYTES, Math.ceil(sizeBytes / MAX_PARTS))
    return { taillePartOctets, parts: Math.max(1, Math.ceil(sizeBytes / taillePartOctets)) }
  }

  signParts(worker: Worker, jobId: string, numeros: number[]): SignedPart[] {
    const vod = this.requireVod()
    const job = this.held(worker, jobId)
    if (job.s3UploadId == null || job.outputKey == null) {
      throw new MontageError('PRECONDITION_FAILED', 'aucun envoi ouvert : appeler montage.envoi d’abord')
    }
    return numeros.map((numero) => vod.signPart(job.outputKey!, job.s3UploadId!, numero))
  }

  async complete(
    worker: Worker,
    input: { jobId: string; parts: { n: number; etag: string }[]; durationMs: number; marquesManquantes: ('debut' | 'fin')[] },
  ): Promise<string> {
    const vod = this.requireVod()
    const job = this.held(worker, input.jobId)
    if (job.s3UploadId == null || job.outputKey == null) {
      throw new MontageError('PRECONDITION_FAILED', 'aucun envoi ouvert : appeler montage.envoi d’abord')
    }
    await vod.completeMultipart(job.outputKey, job.s3UploadId, input.parts)
    this.db
      .update(montageJob)
      .set({
        state: 'termine',
        etape: null,
        pourcent: 100,
        s3UploadId: null,
        leaseUntil: null,
        durationMs: input.durationMs,
        marquesManquantes: JSON.stringify(input.marquesManquantes),
        erreur: null,
        finishedAt: this.iso(),
        updatedAt: this.iso(),
      })
      .where(eq(montageJob.id, job.id))
      .run()
    this.onLog('info', 'montage terminé', { jobId: job.id, sessionId: job.sessionId, objectKey: job.outputKey })
    return job.outputKey
  }

  async fail(worker: Worker, jobId: string, raison: string, reessayer: boolean): Promise<void> {
    const job = this.job(jobId)
    if (job.workerId !== worker.id) throw new MontageError('CONFLICT', 'ce montage est tenu par un autre worker')
    if (job.state !== 'en-cours') return
    await this.abortOutput(job)
    if (reessayer) {
      // Not the job's fault: the attempt does not count.
      this.db
        .update(montageJob)
        .set({
          state: 'attente',
          workerId: null,
          leaseUntil: null,
          etape: null,
          pourcent: 0,
          tentatives: Math.max(0, job.tentatives - 1),
          pasAvant: new Date(this.now().getTime() + RETRY_DELAY_MS).toISOString(),
          erreur: raison,
          updatedAt: this.iso(),
        })
        .where(eq(montageJob.id, jobId))
        .run()
      return
    }
    this.finish(jobId, 'echoue', raison)
    this.onLog('warn', 'montage échoué', { jobId, sessionId: job.sessionId, raison })
  }

  /* ---------- Console ---------- */

  /** What the talk's intro and outro will show — the console previews it. */
  habillageFor(sessionId: string): VodHabillage {
    return this.habillage(sessionId)
  }

  list(sessionId: string | null): MontageJobView[] {
    this.expireLeases()
    const query = this.db.select().from(montageJob)
    const rows = sessionId == null
      ? query.orderBy(desc(montageJob.createdAt)).limit(500).all()
      : query.where(eq(montageJob.sessionId, sessionId)).orderBy(desc(montageJob.createdAt)).all()
    return rows.map((row) => this.view(row))
  }

  /** Edits the talk's latest take again — after a mark was corrected, a logo changed. */
  async relaunch(sessionId: string): Promise<MontageJobView> {
    const vod = this.requireVod()
    const sidecar = vod.latestSidecar(sessionId)
    if (sidecar == null) {
      throw new MontageError('PRECONDITION_FAILED', 'aucune prise de ce talk n’est encore dans le stockage')
    }
    for (const job of this.db.select().from(montageJob)
      .where(and(eq(montageJob.sessionId, sessionId), inArray(montageJob.state, ['attente', 'en-cours']))).all()) {
      await this.cancel(job.id)
    }
    return this.enqueue({ sessionId, roomId: sidecar.roomId, sidecarUploadId: sidecar.id })
  }

  async cancel(jobId: string): Promise<boolean> {
    const job = this.job(jobId)
    if (job.state !== 'attente' && job.state !== 'en-cours') return false
    await this.abortOutput(job)
    this.finish(jobId, 'annule', null)
    return true
  }

  downloadUrl(jobId: string): string {
    const job = this.job(jobId)
    if (job.state !== 'termine' || job.outputKey == null) {
      throw new MontageError('PRECONDITION_FAILED', 'ce montage n’est pas terminé')
    }
    return this.requireVod().presignGet(job.outputKey, job.outputKey.split('/').pop())
  }

  /* ---------- Internals ---------- */

  /** Leases lapsed: the job goes back to the queue — or fails, after too many attempts. */
  private expireLeases(): void {
    const now = this.iso()
    const lapsed = this.db
      .select()
      .from(montageJob)
      .where(and(eq(montageJob.state, 'en-cours'), lt(montageJob.leaseUntil, now)))
      .all()
    for (const job of lapsed) {
      if (job.tentatives >= MAX_ATTEMPTS) {
        this.finish(job.id, 'echoue', `abandonné par son worker ${job.tentatives} fois de suite`)
        continue
      }
      this.db
        .update(montageJob)
        .set({ state: 'attente', workerId: null, leaseUntil: null, etape: null, pourcent: 0, updatedAt: now })
        .where(and(eq(montageJob.id, job.id), eq(montageJob.state, 'en-cours')))
        .run()
      this.onLog('warn', 'bail de montage expiré : remis en file', { jobId: job.id })
    }
  }

  private async abortOutput(job: JobRow): Promise<void> {
    const vod = this.vod()
    if (vod != null && job.s3UploadId != null && job.outputKey != null) {
      await vod.abortMultipart(job.outputKey, job.s3UploadId)
    }
  }

  private finish(jobId: string, state: MontageState, erreur: string | null): void {
    this.db
      .update(montageJob)
      .set({ state, erreur, etape: null, leaseUntil: null, s3UploadId: null, finishedAt: this.iso(), updatedAt: this.iso() })
      .where(eq(montageJob.id, jobId))
      .run()
  }

  private job(jobId: string): JobRow {
    const row = this.db.select().from(montageJob).where(eq(montageJob.id, jobId)).get()
    if (row == null) throw new MontageError('NOT_FOUND', `montage inconnu : ${jobId}`)
    return row
  }

  /** The job, provided this worker holds it and it is still being edited. */
  private held(worker: Worker, jobId: string): JobRow {
    const job = this.job(jobId)
    if (job.workerId !== worker.id) throw new MontageError('CONFLICT', 'ce montage est tenu par un autre worker')
    if (job.state !== 'en-cours') throw new MontageError('CONFLICT', `ce montage n’est plus en cours (${job.state})`)
    return job
  }

  private requireVod(): VodService {
    const vod = this.vod()
    if (vod == null || !vod.ready()) {
      throw new MontageError('PRECONDITION_FAILED', 'aucun stockage S3 prêt sur ce hub : rien à monter')
    }
    return vod
  }

  private view(row: JobRow): MontageJobView {
    const worker = row.workerId == null
      ? null
      : this.db.select({ nom: montageWorker.nom }).from(montageWorker).where(eq(montageWorker.id, row.workerId)).get()?.nom ?? null
    return {
      id: row.id,
      sessionId: row.sessionId,
      title: this.titleOf(row.sessionId),
      roomId: row.roomId,
      state: row.state as MontageState,
      etape: (row.etape as MontageEtape | null) ?? null,
      pourcent: row.pourcent,
      tentatives: row.tentatives,
      worker,
      pasAvant: row.pasAvant,
      outputKey: row.state === 'termine' ? row.outputKey : null,
      durationMs: row.durationMs,
      marquesManquantes: parseMarks(row.marquesManquantes),
      erreur: row.erreur,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      finishedAt: row.finishedAt,
    }
  }

  private iso(): string {
    return this.now().toISOString()
  }
}

/** A room path's folder, with its separator: `2026-10-30/amphi/`. Either separator — a room may run Windows. */
function folderOf(file: string): string {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return cut < 0 ? '' : file.slice(0, cut + 1)
}

function parseMarks(json: string | null): ('debut' | 'fin')[] {
  if (json == null) return []
  try {
    const read: unknown = JSON.parse(json)
    return Array.isArray(read) ? read.filter((m): m is 'debut' | 'fin' => m === 'debut' || m === 'fin') : []
  } catch {
    return []
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
