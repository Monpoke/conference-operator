import { and, desc, eq, lt, ne } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  DEFAULT_VOD_POLICY,
  type VodKind,
  type SignedPart,
  type UploadPlan,
  type VodPolicy,
  type StorageCheck,
  type UploadView,
} from '@conference-operator/contract'
import { vodUpload } from '@conference-operator/db/hub'
import type { HubDatabase } from '../db.js'
import type { Config } from '../config.js'
import { S3Client, S3Error, nodeTransport, type S3Keys, type S3Transport } from './s3.js'
import type { SettingsService } from './sessions.js'

/**
 * Shipping the rushes back: the register, and the housekeeping.
 *
 * The hub keeps this register because it holds the keys. It is the one that opens
 * a multipart at the storage, the one that collects the ETags — S3 asks for all
 * of them again when reassembling the object, and losing them makes the object
 * unrecoverable even though all its bytes are already there — and the one that
 * abandons what is left hanging.
 *
 * The service does not exist when the storage is not configured: it is `null` in
 * the services bag, and every procedure then refuses and says so. A hub with no
 * S3 must not carry half a feature.
 */

/** Signed addresses: enough for a batch of parts, never for the day. */
const SIGNATURE_TTL_S = 3600

/** Beyond this, the room has probably restarted: the plan is reopened. */
const ORPHAN_MULTIPART_MS = 24 * 3600_000

/** Types the storage will announce to whoever downloads. */
const TYPES: Record<string, string> = {
  '.mkv': 'video/x-matroska',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.json': 'application/json',
}

export interface VodStatus {
  configure: boolean
  endpoint: string | null
  bucket: string | null
  prefix: string | null
  politique: VodPolicy
}

export function s3Keys(config: Config, caCert: string | null = null): S3Keys | null {
  if (config.s3Endpoint == null || config.s3AccessKeyId == null || config.s3SecretAccessKey == null) {
    return null
  }
  return {
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    accessKeyId: config.s3AccessKeyId,
    secretAccessKey: config.s3SecretAccessKey,
    forcePathStyle: config.s3ForcePathStyle,
    caCert,
  }
}

/** Domain error: the hub knows how to sign, but does not yet know where to write. */
export class IncompleteStorage extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IncompleteStorage'
  }
}

export class VodService {
  private housekeeping: NodeJS.Timeout | null = null

  constructor(
    private readonly db: HubDatabase,
    private readonly settings: SettingsService,
    private readonly keys: S3Keys,
    private readonly abandonMinutes: number,
    private readonly nowIso: () => string,
    private readonly onLog: (
      level: 'info' | 'warn',
      message: string,
      context?: unknown,
    ) => void = () => {},
    private readonly transport: S3Transport = nodeTransport,
  ) {}

  /** The storage's address, to name it in an error message. */
  endpoint(): string {
    return this.keys.endpoint
  }

  /**
   * What the hub sends down to the rooms at sync.
   *
   * The CA travels with it: that is what saves going and setting an environment
   * variable on every room machine. The keys, on the other hand, never go down —
   * the room only receives already signed addresses.
   */
  sync(): { actif: boolean; politique: VodPolicy; caCert: string | null } {
    return { actif: true, politique: this.policy(), caCert: this.keys.caCert ?? null }
  }

  policy(): VodPolicy {
    return this.settings.get().vodPolitique ?? DEFAULT_VOD_POLICY
  }

  /** Is the bucket set? The keys are not enough: we need to know where to write. */
  ready(): boolean {
    const bucket = this.settings.get().vodBucket
    return bucket != null && bucket.trim().length > 0
  }

  status(): VodStatus {
    const settings = this.settings.get()
    return {
      configure: this.ready(),
      endpoint: this.keys.endpoint,
      bucket: settings.vodBucket,
      prefix: settings.vodPrefix,
      politique: this.policy(),
    }
  }

  /**
   * Tests the connection by performing the real gesture.
   *
   * Open a multipart, sign a part address, write a few bytes to it, abandon
   * everything. Nothing less answers the question: a `HEAD` on the bucket would
   * say it exists, not that we are allowed to write to it; and an accepted key
   * does not prove a **presigned address** will be accepted — yet it is the
   * signing of the parts that carries the whole upload, and it is the trickiest.
   *
   * Nothing remains: an abandoned multipart leaves no object, and it is the same
   * call as the housekeeping's.
   *
   * Never throws. The diagnosis **is** the answer: an HTTP error would lose the
   * step we stopped at, which is all we came for.
   */
  async check(): Promise<StorageCheck> {
    const steps: StorageCheck['etapes'] = []
    /**
     * The S3 action each step exercises.
     *
     * A bare `AccessDenied` does not say *which* one is missing, and a policy
     * grants five or six: you re-read the list without knowing what you are
     * looking for. It is the last two that are most often missing, because
     * neither is obvious — `PutObject` covers opening a multipart and sending the
     * parts, but **not** abandoning them, which has its own action.
     */
    const ACTION: Record<string, string> = {
      joindre: 's3:ListBucket',
      authentifier: 's3:PutObject (CreateMultipartUpload)',
      signer: 's3:PutObject (UploadPart)',
      nettoyer: 's3:AbortMultipartUpload',
    }
    const passed = (nom: StorageCheck['etapes'][number]['nom']): void => {
      steps.push({ nom, ok: true, detail: null })
    }
    const failed = (
      nom: StorageCheck['etapes'][number]['nom'],
      cause: unknown,
    ): StorageCheck => {
      const raw =
        cause instanceof S3Error ? `${cause.code} : ${cause.message}` : readableCause(cause)
      /**
       * A TLS trust failure is said together with its repair.
       *
       * `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` is exact and unreadable: it does not
       * say that Node ignores the system store, nor where to put the CA. And it
       * is not looked for in the same place depending on whether a CA is already
       * configured — if it is, then it does not cover this certificate, which is a
       * quite different lead from "one is missing".
       */
      const certificate = /CERT|SELF_SIGNED|SIGNATURE/.test(raw)
        ? `${raw} — ${
            this.keys.caCert == null
              ? "le certificat du stockage n'est signé par aucune CA publique : renseigner S3_CA_CERT sur le hub"
              : 'la CA fournie par S3_CA_CERT ne couvre pas ce certificat'
          }`
        : raw
      /**
       * A permission refusal is said together with the action that was missing.
       *
       * `AccessDenied` alone makes you re-read a policy without knowing what you
       * are looking for. Naming the action turns an investigation into one line to
       * add.
       */
      const detail = /AccessDenied|Forbidden|HTTP 403/.test(certificate)
        ? `${certificate} — action requise : ${ACTION[nom] ?? '?'}`
        : certificate
      steps.push({ nom, ok: false, detail })
      return { ok: false, etapes: steps }
    }

    if (!this.ready()) {
      return failed('joindre', new Error("aucun bucket réglé : renseignez-le avant d'éprouver la connexion"))
    }

    /**
     * Reaching it, first and separately.
     *
     * A bare request on the storage's address: the refusal it earns — 403, 404,
     * whatever — already proves what we are after, namely that the network gets
     * through, that the name resolves and that the certificate is accepted.
     * Without that separate step, a firewall and a wrong key would have looked the
     * same, and we would have looked for them in the same place.
     */
    try {
      await this.transport(new URL(this.keys.endpoint).origin, {
        method: 'GET',
        headers: {},
        // The CA counts here as everywhere else. Forgetting it made the check fail
        // on a trust failure the configuration already fixed — a diagnosis that
        // blames what you have just repaired is worse than no diagnosis.
        ca: this.keys.caCert ?? null,
      })
      passed('joindre')
    } catch (cause) {
      return failed('joindre', cause)
    }

    const client = this.client()
    const prefix = (this.settings.get().vodPrefix ?? '').replace(/^\/+|\/+$/g, '')
    const key = [prefix, '.connection-check', ulid()].filter((part) => part !== '').join('/')

    let uploadId: string
    try {
      uploadId = await client.createMultipart(key, 'application/octet-stream')
      passed('authentifier')
    } catch (cause) {
      return failed('authentifier', cause)
    }

    try {
      const response = await this.transport(client.presignPart(key, uploadId, 1, 300), {
        method: 'PUT',
        headers: {},
        body: 'connection-check',
        ca: this.keys.caCert ?? null,
      })
      if (response.status >= 300) {
        throw new S3Error(
          `HTTP ${response.status}`,
          "le stockage a refusé l'adresse signée",
          response.status,
        )
      }
      passed('signer')
    } catch (cause) {
      const failure = failed('signer', cause)
      // Abandon it anyway, and say so: a multipart opened by a failed check would
      // stay billed, which would be rich for a feature half of which is
      // housekeeping. The step is returned after the one that failed, in the order
      // things happened.
      await this.abortAtS3(key, uploadId)
      passed('nettoyer')
      return failure
    }

    try {
      await client.abortMultipart(key, uploadId)
      passed('nettoyer')
    } catch (cause) {
      return failed('nettoyer', cause)
    }

    return { ok: true, etapes: steps }
  }

  /**
   * Empties the bucket's prefix. **Development only** — the router guards it.
   *
   * A prefix is **required**, and that is the guard rail that matters: without it,
   * "empty the prefix" and "empty the bucket" are the same gesture, and a bucket
   * that also serves something else would go too. Refusing is the only recoverable
   * behaviour of the two.
   *
   * The open multiparts go with it: they appear in no object listing — they do not
   * yet exist as objects — and would therefore survive a reset that claims to
   * erase everything.
   */
  async reset(): Promise<{ objets: number; multiparts: number }> {
    const prefix = (this.settings.get().vodPrefix ?? '').replace(/^\/+|\/+$/g, '')
    if (prefix === '') {
      throw new IncompleteStorage(
        "aucun préfixe réglé : la remise à zéro effacerait le bucket entier, ce qu'elle refuse de faire",
      )
    }
    const client = this.client()
    const under = `${prefix}/`

    const keys = await client.listObjects(under)
    for (const key of keys) await client.deleteObject(key)

    const open = await client.listMultiparts(under)
    for (const multipart of open) {
      await this.abortAtS3(multipart.key, multipart.uploadId)
    }

    // The register goes with it: keeping "done" rows pointing at objects that no
    // longer exist would make the console say everything has been shipped back.
    this.db.delete(vodUpload).run()

    this.onLog('info', 'remise à zéro du stockage', {
      prefix: under,
      objects: keys.length,
      multiparts: open.length,
    })
    return { objets: keys.length, multiparts: open.length }
  }

  private client(): S3Client {
    const bucket = this.settings.get().vodBucket
    if (bucket == null || bucket.trim().length === 0) {
      throw new IncompleteStorage(
        'aucun bucket réglé : console → VOD → Stockage, avant de téléverser quoi que ce soit',
      )
    }
    return new S3Client(this.keys, bucket.trim(), this.transport)
  }

  /**
   * `<prefix>/<yyyy-mm-dd>/<room>/<file>`.
   *
   * The file name produced by the room already carries date, room, time and
   * title: the prefix only serves to fit several editions in one bucket. The
   * leading date comes from the **file name** when it carries one, and from the
   * hub's time otherwise — filing a rush from 30 October under the date it was
   * shipped back would make it impossible to find.
   */
  objectKeyFor(roomId: string, file: string): string {
    const name = file.split('/').pop() ?? file
    const date = name.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? this.nowIso().slice(0, 10)
    const prefix = (this.settings.get().vodPrefix ?? '').replace(/^\/+|\/+$/g, '')
    return [prefix, date, roomId, name].filter((part) => part !== '').join('/')
  }

  private contentTypeOf(file: string): string {
    const dot = file.lastIndexOf('.')
    return (dot >= 0 ? TYPES[file.slice(dot).toLowerCase()] : undefined) ?? 'application/octet-stream'
  }

  private partsFrom(json: string): { n: number; etag: string }[] {
    try {
      const read: unknown = JSON.parse(json)
      return Array.isArray(read) ? (read as { n: number; etag: string }[]) : []
    } catch {
      return []
    }
  }

  /**
   * Opens — or resumes — the upload of a file.
   *
   * The `(room, file)` uniqueness in the database does all the work: calling again
   * on a file already in progress finds the row, returns the same plan and the
   * list of parts that have arrived. That is what lets a machine rebooted
   * mid-upload restart from the next part rather than from the first byte — on a
   * three-gigabyte rush and an event network, that is the difference between "it
   * will finish" and "it will never finish".
   */
  async begin(input: {
    roomId: string
    file: string
    sizeBytes: number
    kind: VodKind
    sessionId: string | null
  }): Promise<UploadPlan> {
    const client = this.client()
    const existing = this.db
      .select()
      .from(vodUpload)
      .where(and(eq(vodUpload.roomId, input.roomId), eq(vodUpload.file, input.file)))
      .get()

    // Already uploaded, and the size has not moved: nothing to redo. A rush is not
    // rewritten — if its size changed, it is another file under the same name, and
    // it starts from scratch.
    if (
      existing != null &&
      existing.state === 'termine' &&
      existing.sizeBytes === input.sizeBytes
    ) {
      return existing.s3UploadId == null
        ? {
            mode: 'direct',
            uploadId: existing.id,
            url: client.presignPut(existing.objectKey, SIGNATURE_TTL_S),
            expiresAt: new Date(Date.now() + SIGNATURE_TTL_S * 1000).toISOString(),
          }
        : {
            mode: 'multipart',
            uploadId: existing.id,
            taillePartOctets: existing.partSizeBytes,
            parts: Math.max(1, Math.ceil(existing.sizeBytes / existing.partSizeBytes)),
            recues: this.partsFrom(existing.partsJson).map((part) => part.n),
          }
    }

    const partSize = Math.max(5, this.policy().taillePartMo) * 1024 * 1024
    const resumable =
      existing != null &&
      existing.sizeBytes === input.sizeBytes &&
      existing.s3UploadId != null &&
      existing.partSizeBytes === partSize &&
      existing.state !== 'termine'

    if (resumable && existing != null) {
      this.db
        .update(vodUpload)
        .set({ state: 'en-cours', lastProgressAt: this.nowIso(), lastError: null })
        .where(eq(vodUpload.id, existing.id))
        .run()
      return {
        mode: 'multipart',
        uploadId: existing.id,
        taillePartOctets: existing.partSizeBytes,
        parts: Math.max(1, Math.ceil(input.sizeBytes / existing.partSizeBytes)),
        recues: this.partsFrom(existing.partsJson).map((part) => part.n),
      }
    }

    // A plan we replace leaves a multipart open at the storage: we abandon it
    // right away rather than wait for the housekeeping, otherwise changing the
    // part size in the console would bill a whole rush per attempt.
    if (existing?.s3UploadId != null) {
      await this.abortAtS3(existing.objectKey, existing.s3UploadId)
    }

    const objectKey = this.objectKeyFor(input.roomId, input.file)
    const direct = input.kind === 'sidecar' || input.sizeBytes <= partSize
    const id = existing?.id ?? ulid()
    const s3UploadId = direct
      ? null
      : await client.createMultipart(objectKey, this.contentTypeOf(input.file))

    const row = {
      id,
      roomId: input.roomId,
      file: input.file,
      kind: input.kind,
      sessionId: input.sessionId,
      objectKey,
      sizeBytes: input.sizeBytes,
      partSizeBytes: partSize,
      bytesSent: 0,
      s3UploadId,
      partsJson: '[]',
      state: 'en-cours',
      debitOctetsS: null,
      startedAt: this.nowIso(),
      lastProgressAt: this.nowIso(),
      finishedAt: null,
      attempts: (existing?.attempts ?? 0) + 1,
      lastError: null,
    }
    this.db
      .insert(vodUpload)
      .values(row)
      .onConflictDoUpdate({ target: vodUpload.id, set: row })
      .run()

    if (direct) {
      return {
        mode: 'direct',
        uploadId: id,
        url: client.presignPut(objectKey, SIGNATURE_TTL_S),
        expiresAt: new Date(Date.now() + SIGNATURE_TTL_S * 1000).toISOString(),
      }
    }
    return {
      mode: 'multipart',
      uploadId: id,
      taillePartOctets: partSize,
      parts: Math.max(1, Math.ceil(input.sizeBytes / partSize)),
      recues: [],
    }
  }

  /** Signs a batch of parts. Always on demand: a signed address expires. */
  parts(roomId: string, uploadId: string, numeros: number[]): SignedPart[] {
    const row = this.row(roomId, uploadId)
    if (row.s3UploadId == null) {
      throw new IncompleteStorage('ce téléversement est direct : il n\'a pas de parts')
    }
    const client = this.client()
    const expiresAt = new Date(Date.now() + SIGNATURE_TTL_S * 1000).toISOString()
    return numeros.map((numero) => ({
      numero,
      url: client.presignPart(row.objectKey, row.s3UploadId as string, numero, SIGNATURE_TTL_S),
      expiresAt,
    }))
  }

  /** A part has arrived: we keep its ETag, without which nothing reassembles. */
  progress(input: {
    roomId: string
    uploadId: string
    numero: number
    etag: string
    octets: number
    dureeMs: number
  }): void {
    const row = this.row(input.roomId, input.uploadId)
    const parts = this.partsFrom(row.partsJson).filter((part) => part.n !== input.numero)
    parts.push({ n: input.numero, etag: input.etag })

    this.db
      .update(vodUpload)
      .set({
        partsJson: JSON.stringify(parts.sort((a, b) => a.n - b.n)),
        // Recounted from the acknowledged parts, not accumulated: a part replayed
        // after a failure would otherwise exceed the file's size, and the console
        // would show 112%.
        bytesSent: Math.min(row.sizeBytes, parts.length * row.partSizeBytes),
        debitOctetsS:
          input.dureeMs > 0 ? Math.round((input.octets * 1000) / input.dureeMs) : null,
        lastProgressAt: this.nowIso(),
        state: 'en-cours',
        lastError: null,
      })
      .where(eq(vodUpload.id, row.id))
      .run()
  }

  async complete(roomId: string, uploadId: string): Promise<string> {
    const row = this.row(roomId, uploadId)
    if (row.s3UploadId != null) {
      await this.client().completeMultipart(
        row.objectKey,
        row.s3UploadId,
        this.partsFrom(row.partsJson),
      )
    }
    this.db
      .update(vodUpload)
      .set({
        state: 'termine',
        bytesSent: row.sizeBytes,
        finishedAt: this.nowIso(),
        lastProgressAt: this.nowIso(),
        lastError: null,
      })
      .where(eq(vodUpload.id, row.id))
      .run()
    this.onLog('info', 'rush téléversé', { roomId, file: row.file, objectKey: row.objectKey })
    return row.objectKey
  }

  async abort(roomId: string, uploadId: string, raison: string): Promise<void> {
    const row = this.row(roomId, uploadId)
    if (row.s3UploadId != null) {
      await this.abortAtS3(row.objectKey, row.s3UploadId)
    }
    this.db
      .update(vodUpload)
      .set({ state: 'abandonne', lastError: raison, finishedAt: this.nowIso() })
      .where(eq(vodUpload.id, row.id))
      .run()
  }

  uploads(roomId: string | null, roomName: (id: string) => string | null): UploadView[] {
    const rows = roomId == null
      ? this.db.select().from(vodUpload).orderBy(desc(vodUpload.startedAt)).all()
      : this.db
          .select()
          .from(vodUpload)
          .where(eq(vodUpload.roomId, roomId))
          .orderBy(desc(vodUpload.startedAt))
          .all()

    return rows.map((row) => ({
      roomId: row.roomId,
      roomName: roomName(row.roomId),
      file: row.file,
      kind: row.kind as VodKind,
      sessionId: row.sessionId,
      objectKey: row.objectKey,
      state: row.state as UploadView['state'],
      sizeBytes: row.sizeBytes,
      bytesSent: row.bytesSent,
      debitOctetsS: row.debitOctetsS,
      startedAt: row.startedAt,
      lastProgressAt: row.lastProgressAt,
      finishedAt: row.finishedAt,
      attempts: row.attempts,
      lastError: row.lastError,
    }))
  }

  /**
   * The uploads of **one** talk, across every room and every attempt.
   *
   * With no room filter: a relayed slot, or a room renamed along the way, leaves
   * rows under two identifiers, and showing only half of them would be worse than
   * showing nothing. The rush and its sidecar arrive together, most recent first —
   * which puts the current attempt at the top when a first one failed.
   */
  forSession(sessionId: string, roomName: (id: string) => string | null): UploadView[] {
    return this.uploads(null, roomName).filter((row) => row.sessionId === sessionId)
  }

  /**
   * Abandons a multipart without ever throwing.
   *
   * The housekeeping runs in the background: a momentarily unreachable storage
   * must not stop the loop, and the row will be picked up on the next pass. It is
   * the same rule as everywhere else here.
   */
  private async abortAtS3(objectKey: string, s3UploadId: string): Promise<void> {
    try {
      await this.client().abortMultipart(objectKey, s3UploadId)
    } catch (cause) {
      const code = cause instanceof S3Error ? cause.code : (cause as Error).message
      this.onLog('warn', 'abandon du multipart refusé par le stockage', { objectKey, code })
    }
  }

  private row(roomId: string, uploadId: string) {
    const found = this.db
      .select()
      .from(vodUpload)
      .where(and(eq(vodUpload.id, uploadId), eq(vodUpload.roomId, roomId)))
      .get()
    if (found == null) {
      throw new IncompleteStorage('téléversement inconnu — le redemander par `vod.begin`')
    }
    return found
  }

  /**
   * One housekeeping pass: what no longer progresses is abandoned.
   *
   * A room switched off mid-upload says nothing. Without this deadline, its
   * multipart would stay open — and billed — indefinitely, and nobody would know
   * before the invoice.
   */
  async housekeepingPass(): Promise<number> {
    if (!this.ready()) return 0
    const limit = new Date(Date.now() - this.abandonMinutes * 60_000).toISOString()
    const silent = this.db
      .select()
      .from(vodUpload)
      .where(and(eq(vodUpload.state, 'en-cours'), lt(vodUpload.lastProgressAt, limit)))
      .all()

    for (const row of silent) {
      if (row.s3UploadId != null) await this.abortAtS3(row.objectKey, row.s3UploadId)
      this.db
        .update(vodUpload)
        .set({
          state: 'abandonne',
          lastError: `sans nouvelle depuis ${this.abandonMinutes} min`,
          finishedAt: this.nowIso(),
        })
        .where(eq(vodUpload.id, row.id))
        .run()
    }
    if (silent.length > 0) {
      this.onLog('info', 'téléversements muets abandonnés', { count: silent.length })
    }
    return silent.length
  }

  /**
   * The multiparts nobody claims any more.
   *
   * The register only knows what *this* hub opened. A recreated database — the
   * textbook case — leaves at the storage multiparts no row talks about any more,
   * and that nothing would ever abandon. We only touch those older than
   * twenty-four hours: below that, a room may still be feeding them, and a
   * two-hour rush uploads slowly.
   */
  async sweepOrphans(): Promise<number> {
    if (!this.ready()) return 0
    const prefix = (this.settings.get().vodPrefix ?? '').replace(/^\/+|\/+$/g, '')
    let open
    try {
      open = await this.client().listMultiparts(prefix === '' ? '' : `${prefix}/`)
    } catch (cause) {
      const code = cause instanceof S3Error ? cause.code : (cause as Error).message
      this.onLog('warn', 'inventaire des téléversements ouverts impossible', { code })
      return 0
    }

    const known = new Set(
      this.db
        .select({ s3UploadId: vodUpload.s3UploadId })
        .from(vodUpload)
        .where(ne(vodUpload.state, 'termine'))
        .all()
        .map((row) => row.s3UploadId)
        .filter((value): value is string => value != null),
    )

    const limit = Date.now() - ORPHAN_MULTIPART_MS
    let abandoned = 0
    for (const item of open) {
      if (known.has(item.uploadId)) continue
      // With no opening date we do not decide: better to leave a multipart lying
      // around than delete one a room is feeding right now.
      const openedAt = item.initiatedAt == null ? null : Date.parse(item.initiatedAt)
      if (openedAt == null || Number.isNaN(openedAt) || openedAt > limit) continue
      await this.abortAtS3(item.key, item.uploadId)
      abandoned += 1
    }
    if (abandoned > 0) {
      this.onLog('info', 'multiparts orphelins abandonnés', { count: abandoned })
    }
    return abandoned
  }

  /**
   * Starts the housekeeping loop.
   *
   * Ten minutes, and not fifteen seconds like supervision: nothing here is watched
   * live, and querying the storage in a loop would cost billed requests for a
   * problem measured in hours.
   */
  startHousekeeping(intervalMs = 600_000): void {
    if (this.housekeeping != null) return
    let running = false
    const pass = (): void => {
      if (running) return
      running = true
      void this.housekeepingPass()
        .catch(() => {})
        .finally(() => {
          running = false
        })
    }
    this.housekeeping = setInterval(pass, intervalMs)
    this.housekeeping.unref?.()
  }

  stopHousekeeping(): void {
    if (this.housekeeping != null) clearInterval(this.housekeeping)
    this.housekeeping = null
  }
}

/**
 * The real reason for a network failure, under the transport layer.
 *
 * The errno code tells a switched-off service (`ECONNREFUSED`) from a name that
 * does not resolve (`ENOTFOUND`), from a certificate we cannot verify
 * (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`) and from a firewall that leaves it
 * hanging (`ETIMEDOUT`). Four failures, four different places to go and look.
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
