import { createWriteStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

/** Downloads a signed address to a file, streamed: a rush does not fit in memory. */
export async function download(url: string, file: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(url, { signal })
  if (!response.ok || response.body == null) {
    throw new Error(`téléchargement refusé (HTTP ${response.status}) : ${new URL(url).pathname}`)
  }
  await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), createWriteStream(file))
}

export interface MultipartTarget {
  /** Signs a batch of parts — addresses expire, so they are asked for as needed. */
  sign: (numeros: number[]) => Promise<{ numero: number; url: string }[]>
  partSize: number
  parts: number
}

/**
 * Uploads a file in parts to signed addresses; returns the ETags, which the
 * hub needs to reassemble the object.
 *
 * Each part is read from disk when its turn comes, and retried on its own: a
 * network hiccup on part 140 of 200 does not restart the video.
 */
export async function uploadParts(
  file: string,
  target: MultipartTarget,
  options: { concurrency: number; onProgress?: (fraction: number) => void; fetcher?: typeof fetch } = { concurrency: 4 },
): Promise<{ n: number; etag: string }[]> {
  const send = options.fetcher ?? fetch
  const { size } = await stat(file)
  const handle = await open(file, 'r')
  const etags: { n: number; etag: string }[] = []
  let next = 1
  let done = 0
  try {
    const batch = async (): Promise<void> => {
      for (;;) {
        // Signed a few at a time: enough to keep the workers busy, never a whole
        // day of addresses at once.
        const numeros: number[] = []
        while (numeros.length < 5 && next <= target.parts) numeros.push(next++)
        if (numeros.length === 0) return
        for (const { numero, url } of await target.sign(numeros)) {
          const start = (numero - 1) * target.partSize
          const length = Math.min(target.partSize, size - start)
          const buffer = new Uint8Array(length)
          await handle.read(buffer, 0, length, start)
          etags.push({ n: numero, etag: await putWithRetry(send, url, buffer) })
          done += 1
          options.onProgress?.(done / target.parts)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(options.concurrency, target.parts) }, batch))
  } finally {
    await handle.close()
  }
  return etags.sort((a, b) => a.n - b.n)
}

async function putWithRetry(send: typeof fetch, url: string, body: Uint8Array<ArrayBuffer>, attempts = 4): Promise<string> {
  let last: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await send(url, { method: 'PUT', body })
      const etag = response.headers.get('etag')
      if (response.ok && etag) return etag
      last = new Error(`part refusée (HTTP ${response.status})`)
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt))
  }
  throw last instanceof Error ? last : new Error(String(last))
}
