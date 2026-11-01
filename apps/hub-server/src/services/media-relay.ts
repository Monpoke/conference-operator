/**
 * A file of the storage, handed on as the browser asked for it.
 *
 * From the hub's own address, the page may process the sound: a browser refuses
 * that for a medium of another origin unless the storage says otherwise. Nothing
 * is kept: the body flows through, and each jump in the video is its own request.
 */
const KEPT_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']

/**
 * What one answer carries at most. The browser asks for the next part by itself,
 * so a long listening is many short requests: none lasts long enough for a proxy's
 * timeout to cut it, and a jump never leaves a large transfer running behind it.
 */
export const RELAY_CHUNK_BYTES = 16 * 1024 * 1024

/** The range to ask the storage for: what the browser asked, within one chunk. */
export function chunkedRange(range: string | undefined, chunkBytes = RELAY_CHUNK_BYTES): string {
  const match = range == null ? null : /^bytes=(\d+)-(\d*)$/.exec(range.trim())
  const start = match == null ? 0 : Number(match[1])
  const wanted = match?.[2] ? Number(match[2]) : Number.POSITIVE_INFINITY
  return `bytes=${start}-${Math.min(wanted, start + chunkBytes - 1)}`
}

export interface RelayedMedia {
  status: number
  headers: Record<string, string>
  body: ReadableStream<Uint8Array> | null
}

export async function relayMedia(url: string, range: string | undefined, fetcher: typeof fetch = fetch): Promise<RelayedMedia> {
  const response = await fetcher(url, { headers: { range: chunkedRange(range) } })
  const headers: Record<string, string> = {}
  for (const name of KEPT_HEADERS) {
    const value = response.headers.get(name)
    if (value != null) headers[name] = value
  }
  return { status: response.status, headers, body: response.body }
}
