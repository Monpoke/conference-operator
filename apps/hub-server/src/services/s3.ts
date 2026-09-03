import { createHash, createHmac } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/**
 * The strict minimum of S3, signed by hand.
 *
 * The official SDK weighs some fifteen megabytes and a fast-moving family of
 * packages, for six operations none of which goes beyond one HTTP request. SigV4
 * fits in about a hundred lines of `node:crypto`, and the repository has neither
 * a bundler nor an SDK — adding one here would be the first.
 *
 * The signature is checked against AWS's official vectors
 * (`apps/hub-server/test/s3.test.ts`): it is the only way to be sure of an
 * algorithm whose slightest error only shows up as a `SignatureDoesNotMatch`
 * with no detail.
 */

export interface S3Keys {
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** `endpoint/bucket/key` rather than `bucket.endpoint/key`. */
  forcePathStyle: boolean
  /**
   * Additional certificate authority, in PEM format.
   *
   * For internal storage whose certificate is signed by a corporate CA: Node does
   * not use the system store, and the connection would fail with
   * `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.
   */
  caCert?: string | null
}

/** What a transport returns. Deliberately poor: it is all we read. */
export interface S3Response {
  status: number
  body: string
}

/**
 * An HTTP call, injectable.
 *
 * `node:https` rather than `fetch`, for one reason only: `fetch` does not let a
 * certificate authority be added. undici's `Agent` would allow it, but Node does
 * not expose it publicly and adding it as a dependency would mean embedding a
 * second time what Node already contains.
 *
 * The side benefit is not small: `Content-Length` is set exactly, where `fetch`
 * over a stream switches to chunked encoding, which S3 refuses on a signed
 * address.
 */
export type S3Transport = (
  url: string,
  options: { method: string; headers: Record<string, string>; body?: string; ca?: string | null },
) => Promise<S3Response>

/**
 * Idle timeout, and not total timeout.
 *
 * `CompleteMultipartUpload` can hold the connection open for several minutes
 * while the storage reassembles an object of several gigabytes — a total timeout
 * would cut precisely the big rushes, that is, the ones that matter. Idleness, on
 * the other hand, only fires if nothing arrives any more: storage that accepts
 * the connection then goes quiet must not hold the hub for the night.
 */
const IDLE_MS = 120_000

export const nodeTransport: S3Transport = (url, options) =>
  new Promise<S3Response>((resolve, reject) => {
    const target = new URL(url)
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    const body = options.body == null ? null : Buffer.from(options.body, 'utf8')
    const request = send(
      target,
      {
        method: options.method,
        headers: {
          ...options.headers,
          ...(body == null ? {} : { 'content-length': String(body.byteLength) }),
        },
        ...(options.ca == null ? {} : { ca: options.ca }),
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    request.setTimeout(IDLE_MS, () => {
      request.destroy(
        Object.assign(new Error(`aucune réponse du stockage depuis ${IDLE_MS / 1000} s`), {
          code: 'ETIMEDOUT',
        }),
      )
    })
    request.on('error', reject)
    if (body != null) request.write(body)
    request.end()
  })

export interface S3Request {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE'
  /** Already resolved and encoded path, starting with `/`. */
  path: string
  /** Query parameters, unencoded. An empty value gives a bare flag (`?uploads`). */
  query?: Record<string, string>
  headers?: Record<string, string>
  /** Already serialized body. Absent = empty body. */
  body?: string
}

const ALGORITHM = 'AWS4-HMAC-SHA256'
/** Unsigned payload: that is what a storage reads on a presigned address. */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex')

const hmac = (key: Uint8Array | string, message: string): Uint8Array =>
  new Uint8Array(createHmac('sha256', key).update(message).digest())

/**
 * RFC 3986 encoding, the one SigV4 requires.
 *
 * `encodeURIComponent` lets through five characters the standard wants encoded.
 * Forgetting them breaks nothing as long as no talk title carries an apostrophe
 * or brackets — that is, until the day one does, and *that file alone* refuses to
 * upload.
 */
function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** Encodes a path keeping its slashes: S3 does not double-encode its own. */
export function encodePath(path: string): string {
  return path.split('/').map(encode).join('/')
}

/** Parameters sorted by name, each encoded. That order is what enters the signature. */
function queryString(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((name) => `${encode(name)}=${encode(query[name] ?? '')}`)
    .join('&')
}

function timestamp(at: Date): { amzDate: string; day: string } {
  const amzDate = at.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amzDate, day: amzDate.slice(0, 8) }
}

function signingKey(keys: S3Keys, day: string): Uint8Array {
  const date = hmac(`AWS4${keys.secretAccessKey}`, day)
  const region = hmac(date, keys.region)
  const service = hmac(region, 's3')
  return hmac(service, 'aws4_request')
}

interface Canonical {
  request: string
  signedHeaders: string
}

function canonicalize(
  request: S3Request,
  headers: Record<string, string>,
  payloadHash: string,
): Canonical {
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort()
  const lines = names
    .map((name) => {
      const value = headers[Object.keys(headers).find((k) => k.toLowerCase() === name) ?? name] ?? ''
      return `${name}:${value.trim().replace(/\s+/g, ' ')}\n`
    })
    .join('')
  const signedHeaders = names.join(';')

  return {
    request: [
      request.method,
      request.path,
      queryString(request.query ?? {}),
      lines,
      signedHeaders,
      payloadHash,
    ].join('\n'),
    signedHeaders,
  }
}

/**
 * Signs a request through its headers. That is the shape of the calls the hub
 * makes itself — opening a multipart, closing it, abandoning it.
 */
export function signV4(
  keys: S3Keys,
  request: S3Request,
  at: Date = new Date(),
): Record<string, string> {
  const { amzDate, day } = timestamp(at)
  const payloadHash = sha256(request.body ?? '')
  const host = new URL(keys.endpoint).host

  const headers: Record<string, string> = {
    ...request.headers,
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }

  const { request: canonical, signedHeaders } = canonicalize(request, headers, payloadHash)
  const scope = `${day}/${keys.region}/s3/aws4_request`
  const toSign = [ALGORITHM, amzDate, scope, sha256(canonical)].join('\n')
  const signature = Buffer.from(hmac(signingKey(keys, day), toSign)).toString('hex')

  return {
    ...headers,
    authorization:
      `${ALGORITHM} Credential=${keys.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

/**
 * Signs a request inside its address, so that somebody else can execute it.
 *
 * That is the **whole** reason this module exists: the room holds the files, the
 * hub holds the keys, and a presigned address is the only way to let the first
 * write to the storage without ever entrusting it with the second.
 */
export function presign(
  keys: S3Keys,
  request: S3Request,
  expiresInS: number,
  at: Date = new Date(),
): string {
  const { amzDate, day } = timestamp(at)
  const host = new URL(keys.endpoint).host
  const scope = `${day}/${keys.region}/s3/aws4_request`

  const query: Record<string, string> = {
    ...request.query,
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${keys.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresInS),
    'X-Amz-SignedHeaders': 'host',
  }

  const { request: canonical } = canonicalize(
    { ...request, query },
    { host },
    UNSIGNED_PAYLOAD,
  )
  const toSign = [ALGORITHM, amzDate, scope, sha256(canonical)].join('\n')
  const signature = Buffer.from(hmac(signingKey(keys, day), toSign)).toString('hex')

  const base = new URL(keys.endpoint)
  return `${base.origin}${request.path}?${queryString(query)}&X-Amz-Signature=${signature}`
}

/**
 * What S3 returns when it refuses.
 *
 * The `code` is passed through as is — `SignatureDoesNotMatch`, `NoSuchBucket`,
 * `AccessDenied` — because it is what says where to look, and a translated
 * message would lose the one word you can put into a search engine. It travels
 * all the way to the console.
 */
export class S3Error extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'S3Error'
  }
}

const tag = (xml: string, name: string): string | null => {
  const found = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
  return found?.[1]?.trim() ?? null
}

/**
 * An S3 response in error, including one disguised as a success.
 *
 * `CompleteMultipartUpload` can answer **200 with an error in the body**: the
 * request holds the connection open while the storage reassembles the object, and
 * the status leaves before the verdict. Trusting its code would mark as "done" a
 * rush that does not exist.
 */
function check(status: number, xml: string): void {
  if (status < 300 && !xml.includes('<Error>')) return
  throw new S3Error(
    tag(xml, 'Code') ?? `HTTP ${status}`,
    tag(xml, 'Message') ?? xml.slice(0, 300),
    status,
  )
}

export interface OpenMultipart {
  key: string
  uploadId: string
  initiatedAt: string | null
}

/** What the hub knows how to do with a bucket. Nothing more, and deliberately so. */
export class S3Client {
  constructor(
    private readonly keys: S3Keys,
    private readonly bucket: string,
    private readonly transport: S3Transport = nodeTransport,
  ) {}

  /** `/bucket/key`, or `/key` when the host already carries the bucket. */
  private path(key?: string): string {
    const suffix = key == null ? '' : `/${encodePath(key)}`
    return this.keys.forcePathStyle ? `/${encode(this.bucket)}${suffix}` : suffix || '/'
  }

  private host(): string {
    const base = new URL(this.keys.endpoint)
    if (this.keys.forcePathStyle) return base.origin
    return `${base.protocol}//${this.bucket}.${base.host}`
  }

  private keysFor(): S3Keys {
    if (this.keys.forcePathStyle) return this.keys
    return { ...this.keys, endpoint: this.host() }
  }

  private async call(request: S3Request): Promise<string> {
    const keys = this.keysFor()
    const headers = signV4(keys, request)
    const query = queryString(request.query ?? {})
    const url = `${new URL(keys.endpoint).origin}${request.path}${query ? `?${query}` : ''}`

    const response = await this.transport(url, {
      method: request.method,
      headers,
      body: request.body,
      ca: this.keys.caCert ?? null,
    })
    check(response.status, response.body)
    return response.body
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    const xml = await this.call({
      method: 'POST',
      path: this.path(key),
      query: { uploads: '' },
      headers: { 'content-type': contentType },
    })
    const uploadId = tag(xml, 'UploadId')
    if (uploadId == null) {
      throw new S3Error('ReponseIllisible', "le stockage n'a pas rendu d'UploadId", 502)
    }
    return uploadId
  }

  /** Signed address to write one part. That is what goes down to the room. */
  presignPart(key: string, uploadId: string, number: number, expiresInS: number): string {
    return presign(
      this.keysFor(),
      {
        method: 'PUT',
        path: this.path(key),
        query: { partNumber: String(number), uploadId },
      },
      expiresInS,
    )
  }

  /** Signed address to write a whole object — the sidecar, a few kilobytes. */
  presignPut(key: string, expiresInS: number): string {
    return presign(this.keysFor(), { method: 'PUT', path: this.path(key) }, expiresInS)
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: { n: number; etag: string }[],
  ): Promise<void> {
    // The order is that of the part numbers, not that of arrival: the storage
    // reassembles in the order we give it, and a room replaying a failed part
    // necessarily acknowledges them out of order.
    const body =
      '<CompleteMultipartUpload>' +
      [...parts]
        .sort((a, b) => a.n - b.n)
        .map((part) => `<Part><PartNumber>${part.n}</PartNumber><ETag>${part.etag}</ETag></Part>`)
        .join('') +
      '</CompleteMultipartUpload>'

    await this.call({
      method: 'POST',
      path: this.path(key),
      query: { uploadId },
      headers: { 'content-type': 'application/xml' },
      body,
    })
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.call({
      method: 'DELETE',
      path: this.path(key),
      query: { uploadId },
    })
  }

  /**
   * The objects present under a prefix.
   *
   * Only used by the development reset: a normal day never needs to read back
   * what it wrote.
   */
  async listObjects(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let next: string | null = null

    // Bounded, like the multipart inventory: a storage that returned pages
    // indefinitely must not hold the hub.
    for (let page = 0; page < 50; page += 1) {
      const query: Record<string, string> = { 'list-type': '2' }
      if (prefix !== '') query.prefix = prefix
      if (next != null) query['continuation-token'] = next

      const xml: string = await this.call({ method: 'GET', path: this.path(), query })
      for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
        const key = tag(block, 'Key')
        if (key != null) keys.push(key)
      }
      if (tag(xml, 'IsTruncated') !== 'true') break
      next = tag(xml, 'NextContinuationToken')
      if (next == null) break
    }

    return keys
  }

  /**
   * Deletes an object.
   *
   * One by one, and not in batches: `DeleteObjects` requires a `Content-MD5`
   * header nothing else here asks for, for a gain that is only measurable beyond
   * several hundred objects. This gesture empties a development prefix, not a
   * warehouse.
   */
  async deleteObject(key: string): Promise<void> {
    await this.call({ method: 'DELETE', path: this.path(key) })
  }

  /**
   * The multiparts open under a prefix.
   *
   * Used by the startup housekeeping, and only by it: it is the only way to find
   * what a hub opened before its database was recreated. The register in the
   * database knows nothing of those any more, and nobody would ever abandon them.
   */
  async listMultiparts(prefix: string): Promise<OpenMultipart[]> {
    const found: OpenMultipart[] = []
    let keyMarker: string | null = null
    let uploadIdMarker: string | null = null

    // Bounded: a bucket that returned pages indefinitely must not hold the hub's
    // startup hostage on an event morning.
    for (let page = 0; page < 20; page += 1) {
      const query: Record<string, string> = { uploads: '' }
      if (prefix !== '') query.prefix = prefix
      if (keyMarker != null) query['key-marker'] = keyMarker
      if (uploadIdMarker != null) query['upload-id-marker'] = uploadIdMarker

      const xml: string = await this.call({ method: 'GET', path: this.path(), query })

      for (const block of xml.match(/<Upload>[\s\S]*?<\/Upload>/g) ?? []) {
        const key = tag(block, 'Key')
        const uploadId = tag(block, 'UploadId')
        if (key != null && uploadId != null) {
          found.push({ key, uploadId, initiatedAt: tag(block, 'Initiated') })
        }
      }

      if (tag(xml, 'IsTruncated') !== 'true') break
      keyMarker = tag(xml, 'NextKeyMarker')
      uploadIdMarker = tag(xml, 'NextUploadIdMarker')
      if (keyMarker == null) break
    }

    return found
  }
}
