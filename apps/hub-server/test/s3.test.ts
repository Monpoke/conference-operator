import { describe, expect, it, vi } from 'vitest'
import {
  S3Client,
  encodePath,
  presign,
  signV4,
  type S3Transport,
} from '../src/services/s3.js'

/**
 * SigV4 written by hand: this test is the only thing that proves it is right.
 *
 * A wrong signature only shows up as a `SignatureDoesNotMatch` with no detail —
 * the storage never says *what* differs, that would give it something to attack
 * the key with. Without reference vectors one would look for the failure in the
 * bucket's rights, the server's clock or the addressing mode, and the only moment
 * one would find it would be the evening of the event, on a rush uploaded by
 * hand.
 *
 * The values below come from AWS's documentation ("Examples: Signature
 * Calculation for Signature Version 4"), with its example credentials. They are
 * frozen: it is what makes refactoring possible.
 */

const KEYS = {
  endpoint: 'https://examplebucket.s3.amazonaws.com',
  region: 'us-east-1',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  forcePathStyle: false,
}

const MAY_24_2013 = new Date('2013-05-24T00:00:00Z')

describe('SigV4 signature', () => {
  it('signs through headers like the official "GET Object" vector', () => {
    const headers = signV4(
      KEYS,
      { method: 'GET', path: '/test.txt', headers: { range: 'bytes=0-9' } },
      MAY_24_2013,
    )

    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    )
    // The empty body does carry its own hash, and not the "unsigned" constant:
    // both are valid but they do not produce the same signature.
    expect(headers['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(headers['x-amz-date']).toBe('20130524T000000Z')
  })

  it('signs inside the address like the official "presigned GET Object" vector', () => {
    const url = presign(KEYS, { method: 'GET', path: '/test.txt' }, 86_400, MAY_24_2013)

    expect(url).toContain(
      'X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    )
    expect(url).toContain('X-Amz-Expires=86400')
    // Only `host` is signed on a presigned address: the room that uses it has no
    // header to reproduce, and that is what makes it usable as is from any HTTP
    // client.
    expect(url).toContain('X-Amz-SignedHeaders=host')
  })

  it('encodes the path keeping its slashes, and without forgetting the forgotten five', () => {
    expect(encodePath('2026-10-30/track-1/talk.mkv')).toBe('2026-10-30/track-1/talk.mkv')
    // A talk's title readily carries an apostrophe or parentheses.
    // `encodeURIComponent` lets them through; SigV4 wants them encoded, and it is
    // exactly those files that would refuse to upload, alone.
    expect(encodePath("l'ia (2026).mkv")).toBe('l%27ia%20%282026%29.mkv')
    expect(encodePath('a+b&c.mkv')).toBe('a%2Bb%26c.mkv')
  })

  /**
   * A talk's title, as it arrives in a file name.
   *
   * The signatures below have been **cross-checked against AWS's SDK**
   * (`botocore`, `generate_presigned_url`): character for character, the same
   * string. That is what makes them trustworthy beyond the two official vectors,
   * which only cover a `GET /test.txt` — and not the only call that matters here,
   * the `PUT` of a part with `partNumber` and `uploadId` in the address.
   *
   * The case is chosen for what it contains: accents, tilde, plus, percent. Those
   * are the ones whose encoding is arguable, and a single one badly encoded does
   * not break uploading — it breaks *that one*, alone, on one rush among twenty
   * others.
   */
  it('signs a prickly file name like AWS\'s SDK', () => {
    const keys = { ...KEYS, endpoint: 'http://localhost:9000', forcePathStyle: true }
    const at = new Date('2026-10-30T11:22:33Z')
    const path = `/rushes-cloudnord/${encodePath('cn26/2026-10-30/track-1/été~à+100%.mkv')}`

    expect(path).toBe('/rushes-cloudnord/cn26/2026-10-30/track-1/%C3%A9t%C3%A9~%C3%A0%2B100%25.mkv')

    // `PUT` of a part: the call that carries the whole upload of a rush.
    expect(
      presign(keys, { method: 'PUT', path, query: { partNumber: '7', uploadId: 'abc~def' } }, 3600, at),
    ).toContain(
      'X-Amz-Signature=34f447dcf04bbd0efacd922f607bcbd69416d3b57b18c5cd93283e19fcaa8536',
    )

    // `PUT` of a whole object: the sidecar.
    expect(presign(keys, { method: 'PUT', path }, 900, at)).toContain(
      'X-Amz-Signature=070892d936f75cfd27c28f95a3d739acf4d847ad37cf0c46ed0e4a35ee9dc137',
    )
  })

  it('sorts the query parameters: the order is what enters the signature', () => {
    const url = presign(
      KEYS,
      { method: 'PUT', path: '/x.mkv', query: { uploadId: 'zz', partNumber: '3' } },
      600,
      MAY_24_2013,
    )
    const params = new URL(url).search.slice(1).split('&').map((p) => p.split('=')[0])
    expect(params.slice(0, -1)).toEqual([...params.slice(0, -1)].sort())
    // The signature comes last: it does not sign itself.
    expect(params.at(-1)).toBe('X-Amz-Signature')
  })
})

describe('S3 client', () => {
  const response = (body: string, status = 200) => ({ status, body })

  const pathKeys = { ...KEYS, endpoint: 'http://localhost:9000', forcePathStyle: true }

  it('opens a multipart and returns its identifier', async () => {
    const fake = vi.fn().mockResolvedValue(
      response('<InitiateMultipartUploadResult><UploadId>abc123</UploadId></InitiateMultipartUploadResult>'),
    )
    const client = new S3Client(pathKeys, 'rushes', fake as unknown as S3Transport)

    expect(await client.createMultipart('2026/talk.mkv', 'video/x-matroska')).toBe('abc123')
    const [url, init] = fake.mock.calls[0] as [string, { method: string }]
    // Path-style addressing: it is the only mode that works on an IP address, so
    // on a developer's MinIO as on a hosting provider's storage.
    expect(url).toBe('http://localhost:9000/rushes/2026/talk.mkv?uploads=')
    expect(init.method).toBe('POST')
  })

  it('recomposes the object in part order, not in arrival order', async () => {
    const fake = vi.fn().mockResolvedValue(response('<CompleteMultipartUploadResult/>'))
    const client = new S3Client(pathKeys, 'rushes', fake as unknown as S3Transport)

    // A part replayed after a failure necessarily acknowledges out of order.
    await client.completeMultipart('talk.mkv', 'u1', [
      { n: 3, etag: '"c"' },
      { n: 1, etag: '"a"' },
      { n: 2, etag: '"b"' },
    ])

    const body = (fake.mock.calls[0]?.[1] as { body: string }).body
    expect(body.indexOf('"a"')).toBeLessThan(body.indexOf('"b"'))
    expect(body.indexOf('"b"')).toBeLessThan(body.indexOf('"c"'))
  })

  it('refuses a completion that answers 200 with an error in the body', async () => {
    // `CompleteMultipartUpload`'s trap case: the connection stays open while the
    // storage recomposes, and the status leaves before the verdict. Believing the
    // code would mark as "finished" a rush that does not exist.
    const fake = vi.fn(async () =>
      response('<Error><Code>InvalidPart</Code><Message>part 2 introuvable</Message></Error>', 200),
    )
    const client = new S3Client(pathKeys, 'rushes', fake as unknown as S3Transport)

    await expect(
      client.completeMultipart('talk.mkv', 'u1', [{ n: 1, etag: '"a"' }]),
    ).rejects.toMatchObject({ code: 'InvalidPart', message: 'part 2 introuvable' })
  })

  it('returns the storage\'s code as is: it is what says where to look', async () => {
    const fake = vi.fn().mockResolvedValue(
      response('<Error><Code>SignatureDoesNotMatch</Code><Message>nope</Message></Error>', 403),
    )
    const client = new S3Client(pathKeys, 'rushes', fake as unknown as S3Transport)

    await expect(client.createMultipart('x.mkv', 'video/x-matroska')).rejects.toMatchObject({
      code: 'SignatureDoesNotMatch',
      status: 403,
    })
  })

  it('unrolls the pagination of the open multiparts', async () => {
    const fake = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          '<ListMultipartUploadsResult><IsTruncated>true</IsTruncated>' +
            '<NextKeyMarker>a.mkv</NextKeyMarker><NextUploadIdMarker>u1</NextUploadIdMarker>' +
            '<Upload><Key>a.mkv</Key><UploadId>u1</UploadId><Initiated>2026-10-30T09:00:00.000Z</Initiated></Upload>' +
            '</ListMultipartUploadsResult>',
        ),
      )
      .mockResolvedValueOnce(
        response(
          '<ListMultipartUploadsResult><IsTruncated>false</IsTruncated>' +
            '<Upload><Key>b.mkv</Key><UploadId>u2</UploadId></Upload>' +
            '</ListMultipartUploadsResult>',
        ),
      )
    const client = new S3Client(pathKeys, 'rushes', fake as unknown as S3Transport)

    const found = await client.listMultiparts('cn26/')
    expect(found.map((m) => m.uploadId)).toEqual(['u1', 'u2'])
    expect(found[0]?.initiatedAt).toBe('2026-10-30T09:00:00.000Z')
    // With no opening date, the cleanup will not abandon it: better to leave a
    // multipart lying around than to delete one a room is still feeding.
    expect(found[1]?.initiatedAt).toBeNull()
  })
})
