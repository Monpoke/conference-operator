import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { VodHabillage } from '@conference-operator/contract'
import { withRetries, type Wait } from './retry.js'

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
}

/** Reads an image, over http(s) or from disk, as a data URI. */
export async function asDataUri(ref: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (ref.startsWith('data:')) return ref
  if (/^https?:\/\//.test(ref)) {
    const response = await fetcher(ref, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`${ref} : HTTP ${response.status}`)
    const type = response.headers.get('content-type')?.split(';')[0]?.trim() || guessType(ref)
    return `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`
  }
  const path = ref.startsWith('file:') ? fileURLToPath(ref) : ref
  return `data:${guessType(path)};base64,${(await readFile(path)).toString('base64')}`
}

const guessType = (ref: string) => TYPES[extname(new URL(ref, 'file:///').pathname).toLowerCase()] ?? 'application/octet-stream'

/** An image the hub keeps itself: unreadable, it means the hub is away, not that the image is gone. */
const isHubAsset = (ref: string) => /^https?:\/\/[^/]+\/assets\//.test(ref)
/** Refused outright: trying again would change nothing, and the name stands in for it. */
const isRefused = (error: unknown) => error instanceof Error && /HTTP 4\d\d/.test(error.message)

/**
 * The same content, every image inlined.
 *
 * The page is captured frame by frame from its first instant: an image still
 * loading would be missing from the first frames and pop in later — or never,
 * on a slow network. An image that cannot be read becomes `null`, and the page
 * shows the name or the initials, as the loop does — except one of the hub's own
 * while the hub is away, which is tried again and then fails the montage.
 */
export async function inlineImages(
  habillage: VodHabillage,
  onError: (ref: string, error: unknown) => void = () => {},
  fetcher: typeof fetch = fetch,
  wait?: Wait,
): Promise<VodHabillage> {
  const cache = new Map<string, Promise<string | null>>()
  const inline = (ref: string | null): Promise<string | null> => {
    if (ref == null) return Promise.resolve(null)
    let pending = cache.get(ref)
    if (pending == null) {
      const read = () => asDataUri(ref, fetcher)
      pending = isHubAsset(ref)
        ? withRetries(read, { wait, giveUpOn: isRefused }).catch((error: unknown) => {
            if (!isRefused(error)) throw error
            onError(ref, error)
            return null
          })
        : read().catch((error: unknown) => {
            onError(ref, error)
            return null
          })
      cache.set(ref, pending)
    }
    return pending
  }

  const [logoUrl, speakers, sponsorPages] = await Promise.all([
    inline(habillage.event.logoUrl),
    Promise.all(habillage.speakers.map(async (s) => ({ ...s, photoUrl: await inline(s.photoUrl) }))),
    Promise.all(habillage.sponsorPages.map(async (page) => ({
      ...page,
      rangs: await Promise.all(page.rangs.map(async (row) => ({
        ...row,
        logos: await Promise.all(row.logos.map(async (logo) => ({ ...logo, logoUrl: await inline(logo.logoUrl) }))),
      }))),
    }))),
  ])
  return { ...habillage, event: { ...habillage.event, logoUrl }, speakers, sponsorPages }
}
