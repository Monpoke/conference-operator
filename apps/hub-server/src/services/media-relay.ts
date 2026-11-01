/**
 * A file of the storage, handed on as the browser asked for it.
 *
 * From the hub's own address, the page may process the sound: a browser refuses
 * that for a medium of another origin unless the storage says otherwise. Nothing
 * is kept: the body flows through, and each jump in the video is its own request.
 */
const KEPT_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']

export interface RelayedMedia {
  status: number
  headers: Record<string, string>
  body: ReadableStream<Uint8Array> | null
}

export async function relayMedia(url: string, range: string | undefined, fetcher: typeof fetch = fetch): Promise<RelayedMedia> {
  const response = await fetcher(url, { headers: range == null ? {} : { range } })
  const headers: Record<string, string> = {}
  for (const name of KEPT_HEADERS) {
    const value = response.headers.get(name)
    if (value != null) headers[name] = value
  }
  return { status: response.status, headers, body: response.body }
}
