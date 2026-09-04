import { createReadStream } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { and, asc, eq, inArray, ne } from 'drizzle-orm'
import { televersement } from '@cloudnord/db/client'
import type { VodKind, SignedPart, UploadPlan, VodPolicy } from '@cloudnord/contract'
import type { LocalStore } from './store.js'
import type { HostLoad } from './host.js'
import {
  waitAfter,
  uploadVerdict,
  type RegulatorInputs,
  type UploadVerdict,
} from './regulator.js'

/**
 * Shipping the rushes back, part by part.
 *
 * Two properties carry all the rest, and they have the same goal: that the
 * transfer of a several-gigabyte file **finishes**, on an event network that will
 * be cut.
 *
 * The first is the resume: the state lives in the local database, not in memory.
 * A restarted machine picks up from the next part. Without it, an outage at ninety
 * percent costs the ninety percent, and a room switched on twice never finishes.
 *
 * The second is that we do only one at a time. One file, one part, one request.
 * Several parallel reads on the disk that is recording is exactly what we do not
 * want — it is the same reason "Check everything" goes through the rushes one by
 * one.
 *
 * The Drizzle column names, the plan's fields (`recues`, `taillePartOctets`,
 * `numero`, `octets`, `dureeMs`) and the state values (`attente`, `en-cours`,
 * `termine`, `abandonne`, `echoue`) are contract names: they do not get renamed.
 */

/** What the room knows of the files present on its disk. */
export interface VodCandidate {
  file: string
  sizeBytes: number
  /** The file moved a few seconds ago: the take may still be running. */
  beingWritten: boolean
  sessionId: string | null
  /** An existing sidecar next to the rush, or `null`. */
  sidecar: { file: string; sizeBytes: number } | null
}

/** The hub, seen from the uploader. Injected: the test does not need a real one. */
export interface HubVod {
  begin(input: {
    file: string
    sizeBytes: number
    kind: VodKind
    sessionId: string | null
  }): Promise<UploadPlan>
  parts(uploadId: string, numeros: number[]): Promise<SignedPart[]>
  progress(input: {
    uploadId: string
    numero: number
    etag: string
    octets: number
    dureeMs: number
  }): Promise<void>
  complete(uploadId: string): Promise<void>
  abort(uploadId: string, reason: string): Promise<void>
}

export interface UploadDeps {
  store: LocalStore
  /** The disk's files, in the order we wish to send them. */
  candidates: () => Promise<VodCandidate[]>
  hub: () => HubVod | null
  policy: () => VodPolicy | null
  load: () => HostLoad
  /** Is OBS-B recording? */
  recording: () => boolean
  talkRunning: () => boolean
  /** Milliseconds before the next talk, on the hub's corrected clock. */
  msBeforeNext: () => number | null
  /** Reading a range of a file. Injected to test with no disk. */
  readRange?: (file: string, start: number, end: number) => Promise<Buffer>
  /** The absolute path of a file relative to the recordings root. */
  pathOf: (file: string) => string | null
  /**
   * The storage's certificate authority, pushed by the hub. `null` = the public
   * CAs are enough.
   */
  caCert?: () => string | null
  sendPart?: (url: string, body: Buffer) => Promise<string>
  wait?: (ms: number) => Promise<void>
  now?: () => number
  onLog?: (level: 'info' | 'warn' | 'error', message: string, context?: unknown) => void
}
import type { UploadRow, UploadsView } from '@cloudnord/contract'

export type { UploadRow, UploadsView }

/** Signed parts asked for at once. Enough not to chatter, not enough to expire. */
const PART_BATCH = 5

/** Beyond this we stop replaying a file: something is wrong, and it has to be seen. */
const MAX_ATTEMPTS = 8

export class Uploads {
  private timer: NodeJS.Timeout | null = null
  /**
   * The pass in flight, if there is one.
   *
   * Kept rather than a plain flag, so that `pass()` **joins** the work in progress
   * instead of returning straight away. A click on "Upload" starts the transfer
   * without waiting for it, but the background loop has to be able to know when it
   * is finished — and a test has to be able to wait for it without guessing how
   * long it takes.
   */
  private inFlight: Promise<void> | null = null
  private lastVerdict: UploadVerdict = {
    allowed: false,
    reason: 'sans-stockage',
    debitMaxOctetsS: null,
    text: 'aucun stockage configuré sur le hub',
  }
  private rateFailures = 0
  /** The file in flight: it is what guarantees we upload only one. */
  private active: string | null = null
  private cancelled = new Set<string>()

  constructor(private readonly deps: UploadDeps) {}

  private get db() {
    return this.deps.store.db
  }

  private get nowMs(): number {
    return (this.deps.now ?? Date.now)()
  }

  private nowIso(): string {
    return new Date(this.nowMs).toISOString()
  }

  /**
   * Queues a file, at a human's request.
   *
   * A null `file` queues everything that is left: it is the control app's "Upload
   * all" and the console's "Retry all". A file already finished does not come back
   * to it — it is at the storage, sending it up again would only pay twice.
   */
  async request(file: string | null): Promise<number> {
    const candidates = await this.deps.candidates()
    const targeted = file == null ? candidates : candidates.filter((c) => c.file === file)
    let queued = 0
    for (const candidate of targeted) {
      const row = this.row(candidate.file)
      if (row?.state === 'termine') continue
      this.cancelled.delete(candidate.file)
      this.upsert(candidate, { manuel: true, state: 'attente', nextAttemptAt: this.nowIso() })
      queued += 1
    }
    if (queued > 0) {
      this.deps.onLog?.('info', 'téléversement demandé', { file, queued })
      void this.pass()
    }
    return queued
  }

  /**
   * Gives up a file in progress.
   *
   * The abort at the storage is asked of the hub — it alone has the keys — but the
   * local row switches straight away: the operator who cancels must see it is
   * done, even if the hub takes ten seconds to answer.
   */
  async cancel(file: string): Promise<void> {
    const row = this.row(file)
    if (row == null || row.state === 'termine') return
    this.cancelled.add(file)
    this.db
      .update(televersement)
      .set({ state: 'abandonne', manuel: false, lastError: 'annulé en régie', finiA: this.nowIso() })
      .where(eq(televersement.file, file))
      .run()

    const hub = this.deps.hub()
    if (hub != null && row.s3UploadId != null) {
      await hub.abort(row.s3UploadId, 'annulé en régie').catch(() => {})
    }
  }

  view(): UploadsView {
    const rows = this.db.select().from(televersement).orderBy(asc(televersement.demandeA)).all()
    return {
      verdict: this.lastVerdict,
      entries: rows.map((row) => ({
        file: row.file,
        state: row.state,
        percent:
          row.tailleOctets > 0
            ? Math.min(100, Math.round((row.octetsEnvoyes / row.tailleOctets) * 100))
            : 0,
        // Bounded to zero as the percentage is bounded to a hundred, and for the
        // same reason: a rush that grew between the queuing and the send would
        // otherwise give a negative remainder, so a negative remaining time.
        remainingBytes: Math.max(0, row.tailleOctets - row.octetsEnvoyes),
        debitOctetsS: row.debitOctetsS,
        error: row.lastError,
        manual: row.manuel,
      })),
    }
  }

  private row(file: string) {
    return this.db.select().from(televersement).where(eq(televersement.file, file)).get()
  }

  private upsert(candidate: VodCandidate, patch: Record<string, unknown>): void {
    const values = {
      file: candidate.file,
      kind: 'rush' as const,
      sessionId: candidate.sessionId,
      tailleOctets: candidate.sizeBytes,
      ...patch,
    }
    this.db
      .insert(televersement)
      .values(values)
      .onConflictDoUpdate({ target: televersement.file, set: patch })
      .run()
  }

  /**
   * Elects the next file to upload.
   *
   * The manual requests first, in the order they arrived: it is the order somebody
   * clicked them in, and honouring it is the only way to make the gesture
   * readable. The rushes still being written are discarded — uploading a take that
   * is still running would produce a truncated file at the storage, and it would
   * look complete.
   */
  private async elect(): Promise<{ candidate: VodCandidate; manual: boolean } | null> {
    const candidates = await this.deps.candidates()
    const byFile = new Map(candidates.map((c) => [c.file, c]))
    const now = this.nowIso()

    const queued = this.db
      .select()
      .from(televersement)
      .where(and(ne(televersement.state, 'termine'), ne(televersement.state, 'abandonne')))
      .orderBy(asc(televersement.demandeA))
      .all()
      .filter((row) => row.nextAttemptAt <= now && row.attempts < MAX_ATTEMPTS)

    for (const row of [...queued].sort((a, b) => Number(b.manuel) - Number(a.manuel))) {
      const candidate = byFile.get(row.file)
      if (candidate == null || candidate.beingWritten) continue
      return { candidate, manual: row.manuel }
    }

    if (!(this.deps.policy()?.actif ?? false)) return null

    // Nothing queued: we take the first rush on the disk nobody has uploaded yet.
    // It is the "automatic" part, and it only switches on if the hub asks for it.
    const handled = new Set(
      this.db
        .select({ file: televersement.file })
        .from(televersement)
        .all()
        .map((row) => row.file),
    )
    const fresh = candidates.find((c) => !c.beingWritten && !handled.has(c.file))
    return fresh == null ? null : { candidate: fresh, manual: false }
  }

  /**
   * One pass. Never throws: it is a background loop.
   *
   * It uploads **a single part** before handing back. That is not a limitation: it
   * is what makes the rate cap applicable, the regulator re-evaluated mid-file,
   * and a cancellation effective within a few seconds rather than at the end of a
   * three-gigabyte rush.
   */
  async pass(): Promise<void> {
    // Join rather than ignore: two concurrent passes would upload two files at a
    // time on the disk that is recording, which is precisely what we avoid.
    if (this.inFlight != null) return this.inFlight
    this.inFlight = this.once()
      .catch((cause: unknown) => {
        this.deps.onLog?.('warn', 'passe de téléversement en échec', {
          message: (cause as Error).message,
        })
      })
      .finally(() => {
        this.inFlight = null
      })
    return this.inFlight
  }

  private verdictFor(manual: boolean): UploadVerdict {
    const policy = this.deps.policy()
    const inputs: RegulatorInputs = {
      storageReady: policy != null && this.deps.hub() != null,
      policy: policy ?? {
        actif: false,
        debitMaxOctetsS: null,
        cpuMax: 0.7,
        margeConferenceMinutes: 10,
        taillePartMo: 8,
      },
      manual,
      recording: this.deps.recording(),
      talkRunning: this.deps.talkRunning(),
      msBeforeNext: this.deps.msBeforeNext(),
      load: this.deps.load(),
      observedRateBytesS: null,
    }
    return uploadVerdict(inputs)
  }

  private async once(): Promise<void> {
    const chosen = await this.elect()
    if (chosen == null) {
      // Nothing to upload: the displayed verdict is that of an automatism at rest,
      // not that of a refusal. Otherwise the control app would say "machine loaded"
      // on a room that simply has nothing left to send.
      this.lastVerdict = this.verdictFor(false)
      return
    }

    const verdict = this.verdictFor(chosen.manual)
    this.lastVerdict = verdict
    if (!verdict.allowed) {
      if (verdict.reason === 'debit') this.rateFailures += 1
      const delay = waitAfter(verdict.reason ?? 'charge', this.rateFailures)
      this.db
        .update(televersement)
        .set({ nextAttemptAt: new Date(this.nowMs + delay).toISOString() })
        .where(eq(televersement.file, chosen.candidate.file))
        .run()
      return
    }

    const hub = this.deps.hub()
    if (hub == null) return

    this.active = chosen.candidate.file
    try {
      await this.upload(
        hub,
        chosen.candidate,
        chosen.candidate.file,
        'rush',
        chosen.candidate.sizeBytes,
        verdict,
      )
      // The sidecar follows the rush, never the other way round: a sidecar alone at
      // the storage would describe a talk whose video did not arrive.
      if (chosen.candidate.sidecar != null && !this.cancelled.has(chosen.candidate.file)) {
        const row = this.row(chosen.candidate.file)
        if (row?.state === 'termine') {
          await this.uploadSidecar(hub, chosen.candidate)
        }
      }
    } catch (cause) {
      this.fail(chosen.candidate.file, cause as Error)
    } finally {
      this.active = null
    }
  }

  private fail(file: string, cause: Error): void {
    const row = this.row(file)
    const attempts = (row?.attempts ?? 0) + 1
    // A firm back-off: a refusal from the storage does not get fixed in fifteen
    // seconds, and replaying in a loop would bury the message in the log.
    const delay = Math.min(10 * 60_000, 20_000 * 2 ** Math.min(attempts, 5))
    this.db
      .update(televersement)
      .set({
        state: attempts >= MAX_ATTEMPTS ? 'echoue' : 'attente',
        attempts,
        lastError: cause.message.slice(0, 300),
        nextAttemptAt: new Date(this.nowMs + delay).toISOString(),
      })
      .where(eq(televersement.file, file))
      .run()
    this.deps.onLog?.(attempts >= MAX_ATTEMPTS ? 'error' : 'warn', 'téléversement en échec', {
      file,
      essais: attempts,
      message: cause.message,
    })
  }

  private async uploadSidecar(hub: HubVod, candidate: VodCandidate): Promise<void> {
    const sidecar = candidate.sidecar
    if (sidecar == null) return
    const plan = await hub.begin({
      file: sidecar.file,
      sizeBytes: sidecar.sizeBytes,
      kind: 'sidecar',
      sessionId: candidate.sessionId,
    })
    if (plan.mode !== 'direct') return
    const body = await this.range(sidecar.file, 0, sidecar.sizeBytes)
    await this.send(plan.url, body)
    await hub.complete(plan.uploadId)
  }

  private async range(file: string, start: number, end: number): Promise<Buffer> {
    if (this.deps.readRange != null) return this.deps.readRange(file, start, end)
    const path = this.deps.pathOf(file)
    if (path == null) throw new Error(`fichier hors de la racine des enregistrements : ${file}`)
    const chunks: Buffer[] = []
    // `end` is inclusive in Node: the upper bound is therefore `end - 1`.
    for await (const block of createReadStream(path, { start, end: end - 1 })) {
      chunks.push(block as Buffer)
    }
    return Buffer.concat(chunks)
  }

  private async send(url: string, body: Buffer): Promise<string> {
    if (this.deps.sendPart != null) return this.deps.sendPart(url, body)
    let response: { status: number; etag: string | null }
    try {
      response = await put(url, body, this.deps.caCert?.() ?? null)
    } catch (cause) {
      /**
       * "fetch failed" says nothing, and it is the only message undici puts on
       * *all* of its transport failures.
       *
       * The real cause is tucked away in `cause`: a service switched off
       * (`ECONNREFUSED`), a name that does not resolve (`ENOTFOUND`), a firewall
       * that leaves it hanging (`ETIMEDOUT`). Three failures that are not fixed in
       * the same place, and the control app only displayed the first line.
       *
       * The host aimed at is named, without the rest of the address: a presigned
       * URL carries a signature and credentials, and a room's log gets read by
       * several people.
       */
      throw new Error(
        `Stockage injoignable (${hostOf(url)}) : ${readableCause(cause)}`,
        { cause },
      )
    }
    if (response.status >= 300) {
      throw new Error(`le stockage a refusé la part (HTTP ${response.status})`)
    }
    const etag = response.etag
    if (etag == null) {
      // With no ETag, the object will not recompose: better to fail here, where the
      // message is clear, than at the completion where the storage will say
      // "InvalidPart".
      throw new Error("le stockage n'a pas rendu d'ETag pour cette part")
    }
    return etag
  }

  /**
   * Uploads a file, part by part, honouring the rate cap.
   *
   * The cap is held **between** the parts, not inside them: after eight megabytes
   * sent in two seconds under a cap of two megabytes a second, we wait two
   * seconds. A coarse grain, but it demands neither a stream to throttle nor a
   * dependency — and it is the part size that sets it, which makes it readable: a
   * figure in the console, a visible consequence.
   */
  private async upload(
    hub: HubVod,
    candidate: VodCandidate,
    file: string,
    kind: VodKind,
    sizeBytes: number,
    verdict: UploadVerdict,
  ): Promise<void> {
    const plan = await hub.begin({ file, sizeBytes, kind, sessionId: candidate.sessionId })

    if (plan.mode === 'direct') {
      this.upsert(candidate, {
        state: 'en-cours',
        s3UploadId: plan.uploadId,
        commenceA: this.nowIso(),
        lastError: null,
      })
      const body = await this.range(file, 0, sizeBytes)
      await this.send(plan.url, body)
      await hub.complete(plan.uploadId)
      this.finish(file, sizeBytes)
      return
    }

    const already = new Set(plan.recues)
    this.upsert(candidate, {
      state: 'en-cours',
      s3UploadId: plan.uploadId,
      taillePartOctets: plan.taillePartOctets,
      partsJson: JSON.stringify([...already]),
      octetsEnvoyes: Math.min(sizeBytes, already.size * plan.taillePartOctets),
      commenceA: this.nowIso(),
      lastError: null,
    })

    const missing: number[] = []
    for (let numero = 1; numero <= plan.parts; numero += 1) {
      if (!already.has(numero)) missing.push(numero)
    }

    const wait = this.deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

    for (let index = 0; index < missing.length; index += PART_BATCH) {
      if (this.cancelled.has(file)) return
      const batch = missing.slice(index, index + PART_BATCH)
      const signed = await hub.parts(plan.uploadId, batch)

      for (const part of signed) {
        if (this.cancelled.has(file)) return
        const start = (part.numero - 1) * plan.taillePartOctets
        const end = Math.min(sizeBytes, start + plan.taillePartOctets)
        const body = await this.range(file, start, end)

        const before = this.nowMs
        const etag = await this.send(part.url, body)
        const dureeMs = this.nowMs - before

        await hub.progress({
          uploadId: plan.uploadId,
          numero: part.numero,
          etag,
          octets: body.byteLength,
          dureeMs,
        })

        already.add(part.numero)
        const rate = dureeMs > 0 ? Math.round((body.byteLength * 1000) / dureeMs) : null
        this.db
          .update(televersement)
          .set({
            partsJson: JSON.stringify([...already].sort((a, b) => a - b)),
            octetsEnvoyes: Math.min(sizeBytes, already.size * plan.taillePartOctets),
            debitOctetsS: rate,
          })
          .where(eq(televersement.file, file))
          .run()

        const cap = verdict.debitMaxOctetsS
        if (cap != null && cap > 0) {
          const atLeast = (body.byteLength / cap) * 1000
          if (atLeast > dureeMs) await wait(Math.round(atLeast - dureeMs))
        }
      }
    }

    await hub.complete(plan.uploadId)
    this.finish(file, sizeBytes)
    this.rateFailures = 0
  }

  private finish(file: string, sizeBytes: number): void {
    this.db
      .update(televersement)
      .set({
        state: 'termine',
        octetsEnvoyes: sizeBytes,
        manuel: false,
        lastError: null,
        finiA: this.nowIso(),
      })
      .where(eq(televersement.file, file))
      .run()
    this.deps.onLog?.('info', 'rush téléversé', { file })
  }

  /**
   * Forgets what no longer exists on disk.
   *
   * A rush erased after being shipped back would otherwise leave an eternal row in
   * the control app's modal, and "finished" on an absent file reads badly.
   */
  async forgetMissing(): Promise<void> {
    const present = new Set((await this.deps.candidates()).flatMap((c) => [c.file, c.sidecar?.file]))
    const rows = this.db.select({ file: televersement.file }).from(televersement).all()
    const gone = rows.map((r) => r.file).filter((file) => !present.has(file))
    if (gone.length > 0) {
      this.db.delete(televersement).where(inArray(televersement.file, gone)).run()
    }
  }

  /**
   * Forgets the whole queue.
   *
   * Goes with the reset: keeping "finished" rows pointing at erased files would
   * make the modal say everything is safe.
   */
  forgetAll(): void {
    this.db.delete(televersement).run()
  }

  start(intervalMs = 15_000): void {
    if (this.timer != null) return
    this.timer = setInterval(() => void this.pass(), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer != null) clearInterval(this.timer)
    this.timer = null
  }
}

/**
 * Puts a part onto a signed address.
 *
 * `node:https` rather than `fetch`, and for the same reason as on the hub side:
 * `fetch` does not let one add a certificate authority, and undici's `Agent` that
 * would allow it is not exposed by Node. Yet an internal storage signed by a
 * corporate CA is exactly the case where one does not want to have to set an
 * environment variable on every room machine.
 *
 * A side benefit: `Content-Length` is set exactly, where `fetch` readily switches
 * to chunked encoding — which S3 refuses on a signed address.
 */
async function put(
  url: string,
  body: Buffer,
  caCert: string | null,
): Promise<{ status: number; etag: string | null }> {
  return await new Promise((resolve, reject) => {
    const target = new URL(url)
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    const request = send(
      target,
      {
        method: 'PUT',
        headers: { 'content-length': String(body.byteLength) },
        ...(caCert == null ? {} : { ca: caCert }),
      },
      (response) => {
        // The body does not interest us, but it has to be consumed: a stream left
        // hanging holds the connection, and the next part would wait for a socket
        // that is never released.
        response.resume()
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            etag: (response.headers.etag as string | undefined) ?? null,
          }),
        )
      },
    )
    /**
     * An inactivity timeout, not a total timeout.
     *
     * An eight-megabyte part on an event network can take a minute without
     * anything being wrong. What we want to cut is the storage that accepts the
     * connection and goes silent — otherwise the room waits until the teardown.
     */
    request.setTimeout(120_000, () => {
      request.destroy(
        Object.assign(new Error('aucune réponse du stockage depuis 120 s'), { code: 'ETIMEDOUT' }),
      )
    })
    request.on('error', reject)
    request.write(body)
    request.end()
  })
}

/** The host of a signed address, without its signature or its credentials. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'adresse illisible'
  }
}

/**
 * The real reason for a network failure, under `fetch`'s layer.
 *
 * The same function as on the hub side, and the same reason: the errno code tells
 * apart failures that are not fixed in the same place, where "fetch failed"
 * confuses them all.
 */
function readableCause(error: unknown): string {
  const chain: string[] = []
  let current: unknown = error
  for (let depth = 0; current != null && depth < 4; depth += 1) {
    const node = current as { message?: string; code?: string; cause?: unknown }
    const code = typeof node.code === 'string' ? node.code : null
    if (code != null) chain.push(code)
    else if (typeof node.message === 'string' && node.message !== '') chain.push(node.message)
    current = node.cause
  }
  return chain.length === 0 ? String(error) : chain.join(' — ')
}
