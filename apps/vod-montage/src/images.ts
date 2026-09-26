import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { VodHabillage } from '@conference-operator/contract'

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

/**
 * The same content, every image inlined.
 *
 * The page is captured frame by frame from its first instant: an image still
 * loading would be missing from the first frames and pop in later — or never,
 * on a slow network. An image that cannot be read becomes `null`, and the page
 * shows the name or the initials, as the loop does.
 */
export async function inlineImages(
  habillage: VodHabillage,
  onError: (ref: string, error: unknown) => void = () => {},
  fetcher: typeof fetch = fetch,
): Promise<VodHabillage> {
  const cache = new Map<string, Promise<string | null>>()
  const inline = (ref: string | null): Promise<string | null> => {
    if (ref == null) return Promise.resolve(null)
    let pending = cache.get(ref)
    if (pending == null) {
      pending = asDataUri(ref, fetcher).catch((error: unknown) => {
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
