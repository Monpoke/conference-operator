import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { assetCache } from '@conference-operator/db/client'
import { assetUrls, type Program } from '@conference-operator/program'
import type { LocalStore } from './store.js'

export interface AssetRef {
  sha256: string
  /** The local URL to substitute into the program served to the screen. */
  localUrl: string
  byteSize: number
  contentType: string | null
}

export interface PrefetchReport {
  downloaded: number
  reused: number
  /** Downloaded from the hub, which is where they are meant to come from. */
  fromHub: number
  /**
   * Downloaded from the upstream export, the hub not holding them.
   *
   * Counted rather than silent: it is the number that says this room still needs
   * the internet, which everything else about it promises it does not.
   */
  fromUpstream: number
  failed: { url: string; reason: string }[]
}

/**
 * A content-addressed asset cache.
 *
 * The stake is precise: once filled, **no OBS browser source touches the
 * Internet** during the event. A network outage therefore cannot make broken
 * logos appear on the video projector.
 */
export class AssetCache {
  constructor(
    private readonly store: LocalStore,
    private readonly directory: string,
    /**
     * Where the bytes come from, in order of preference.
     *
     * The hub holds the programme's images and serves them under the same hash
     * this cache uses — so the room asks for a key it computed itself, with
     * nothing having travelled to tell it what to ask for. The upstream URL stays
     * as the fallback: a hub still catching up on an import must not leave a
     * projector without logos.
     */
    private readonly hubOrigin: string | null = null,
    private readonly basePath = '/assets',
    /**
     * The ceiling on one download.
     *
     * `fetch` sets none of its own. One image server that accepts the connection
     * and then says nothing used to hold this loop open with no way out — and the
     * loop is awaited by the sync that follows a reconnection.
     */
    private readonly timeoutMs = 20_000,
  ) {
    mkdirSync(directory, { recursive: true })
  }

  /** The cache key: the source URL, not the content — it is what we know before downloading. */
  private keyOf(url: string): string {
    return createHash('sha256').update(url).digest('hex')
  }

  fileFor(sha256: string): string | null {
    const row = this.store.db.select().from(assetCache).where(eq(assetCache.sha256, sha256)).get()
    if (row == null) return null
    const path = join(this.directory, sha256 + extensionFor(row.sourceUrl))
    return existsSync(path) ? path : null
  }

  lookup(url: string): AssetRef | null {
    const sha256 = this.keyOf(url)
    const row = this.store.db.select().from(assetCache).where(eq(assetCache.sha256, sha256)).get()
    if (row == null || this.fileFor(sha256) == null) return null
    return {
      sha256,
      localUrl: `${this.basePath}/${sha256}`,
      byteSize: row.byteSize,
      contentType: row.contentType,
    }
  }

  /**
   * Downloads an asset if it is not already cached.
   *
   * Written in two steps (a temporary file then a `rename`): a power cut in the
   * middle of a download would otherwise leave a truncated file the cache would
   * believe valid.
   */
  async fetchOne(
    url: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<AssetRef & { fromHub: boolean }> {
    const existing = this.lookup(url) ?? this.adopt(url)
    if (existing != null) return { ...existing, fromHub: false }

    const { response, fromHub } = await this.download(url, fetchImpl)
    const bytes = Buffer.from(await response.arrayBuffer())
    const sha256 = this.keyOf(url)
    const target = join(this.directory, sha256 + extensionFor(url))
    const temporary = `${target}.partial`

    await writeFile(temporary, bytes)
    await rename(temporary, target)

    const contentType = response.headers.get('content-type')
    this.store.db
      .insert(assetCache)
      .values({ sha256, sourceUrl: url, contentType, byteSize: bytes.byteLength })
      .onConflictDoUpdate({
        target: assetCache.sha256,
        set: { contentType, byteSize: bytes.byteLength, downloadedAt: new Date().toISOString() },
      })
      .run()

    return {
      sha256,
      localUrl: `${this.basePath}/${sha256}`,
      byteSize: bytes.byteLength,
      contentType,
      fromHub,
    }
  }

  /**
   * Takes back a file already on disk whose row has gone.
   *
   * The index lives in `salle.db`; the bytes are beside it. Emptying the database
   * alone — what `pnpm reset:dev` does when asked to keep the images — would
   * otherwise send them all to be downloaded again, for files sitting right
   * there. The URL gives the name, the extension gives the type.
   */
  private adopt(url: string): AssetRef | null {
    const sha256 = this.keyOf(url)
    const path = join(this.directory, sha256 + extensionFor(url))
    if (!existsSync(path)) return null

    const contentType = contentTypeFor(path)
    const byteSize = statSync(path).size
    this.store.db
      .insert(assetCache)
      .values({ sha256, sourceUrl: url, contentType, byteSize })
      .onConflictDoUpdate({ target: assetCache.sha256, set: { contentType, byteSize } })
      .run()

    return { sha256, localUrl: `${this.basePath}/${sha256}`, byteSize, contentType }
  }

  /**
   * The hub first, the source second.
   *
   * The key does not change between the two: it stays the SHA-256 of the
   * **source URL**, which is what the hub hashes too. Keying on where the bytes
   * came from would give two entries for one image, and would make every cache
   * already filled from upstream useless the day the hub starts serving them.
   *
   * A hub that answers 404 is not an incident — it has not imported that
   * programme yet, or the image failed on its side too. We go upstream and the
   * count says so.
   */
  private async download(
    url: string,
    fetchImpl: typeof fetch,
  ): Promise<{ response: Response; fromHub: boolean }> {
    const signal = (): AbortSignal => AbortSignal.timeout(this.timeoutMs)

    if (this.hubOrigin != null) {
      const from = `${this.hubOrigin.replace(/\/$/, '')}${this.basePath}/${this.keyOf(url)}`
      try {
        const response = await fetchImpl(from, { signal: signal() })
        if (response.ok) return { response, fromHub: true }
      } catch {
        // The hub is unreachable — which the rest of the room already knows and
        // says. Nothing to add here beyond going to the source.
      }
    }

    const response = await fetchImpl(url, { signal: signal() })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return { response, fromHub: false }
  }

  /**
   * Prefetches all of a program's assets.
   *
   * Never throws: a missing logo must not stop the room from starting. The
   * failures are returned so they can be displayed in the control app.
   */
  async prefetch(program: Program, fetchImpl: typeof fetch = fetch): Promise<PrefetchReport> {
    return this.prefetchUrls(assetUrls(program), fetchImpl)
  }

  /**
   * Prefetches a list of addresses — the program's, or the loop's images.
   *
   * The loop names images uploaded on the hub (`hub-image:…`), which have no
   * upstream: they come from the hub or not at all, which `download` already
   * does, the second attempt failing on the scheme.
   */
  async prefetchUrls(urls: Iterable<string>, fetchImpl: typeof fetch = fetch): Promise<PrefetchReport> {
    const report: PrefetchReport = {
      downloaded: 0,
      reused: 0,
      fromHub: 0,
      fromUpstream: 0,
      failed: [],
    }

    for (const url of urls) {
      if ((this.lookup(url) ?? this.adopt(url)) != null) {
        report.reused += 1
        continue
      }
      try {
        const { fromHub } = await this.fetchOne(url, fetchImpl)
        report.downloaded += 1
        if (fromHub) report.fromHub += 1
        else report.fromUpstream += 1
      } catch (cause) {
        report.failed.push({ url, reason: (cause as Error).message })
      }
    }
    return report
  }

  /**
   * Rewrites the program's remote URLs towards the local cache.
   *
   * An asset absent from the cache keeps its original URL: better to try the
   * network than to display a dead image if the link is still reachable.
   */
  localize(program: Program): Program {
    const rewrite = (url: string | null): string | null =>
      url == null ? null : (this.lookup(url)?.localUrl ?? url)

    return {
      ...program,
      event: {
        ...program.event,
        logoUrl: rewrite(program.event.logoUrl),
        logoUrl2: rewrite(program.event.logoUrl2),
        backgroundUrl: rewrite(program.event.backgroundUrl),
        intermissionMediaUrl: rewrite(program.event.intermissionMediaUrl),
      },
      speakers: program.speakers.map((speaker) => ({
        ...speaker,
        photoUrl: rewrite(speaker.photoUrl),
        companyLogoUrl: rewrite(speaker.companyLogoUrl),
      })),
      sessions: program.sessions.map((session) => ({
        ...session,
        imageUrl: rewrite(session.imageUrl),
        speakers: session.speakers.map((speaker) => ({
          ...speaker,
          photoUrl: rewrite(speaker.photoUrl),
          companyLogoUrl: rewrite(speaker.companyLogoUrl),
        })),
      })),
      sponsorTiers: program.sponsorTiers.map((tier) => ({
        ...tier,
        sponsors: tier.sponsors.map((sponsor) => ({
          ...sponsor,
          logoUrl: rewrite(sponsor.logoUrl),
        })),
      })),
    }
  }

  /**
   * The local address of one image, or `null` when it is not cached.
   *
   * Stricter than `localize`, on purpose: the loop writes the sponsor's name in
   * its circle rather than send the projector to the Internet for a logo.
   */
  localizeRef(ref: string | null): string | null {
    if (ref == null) return null
    return (this.lookup(ref) ?? this.adopt(ref))?.localUrl ?? null
  }

  async read(sha256: string): Promise<{ bytes: Buffer; contentType: string | null } | null> {
    const path = this.fileFor(sha256)
    if (path == null) return null
    const row = this.store.db.select().from(assetCache).where(eq(assetCache.sha256, sha256)).get()
    return { bytes: await readFile(path), contentType: row?.contentType ?? null }
  }
}

/** Keeps the original extension: OBS and the browsers still rely on it. */
/** The type an extension stands for, for a file taken back without its row. */
function contentTypeFor(path: string): string | null {
  const types: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
  }
  return types[extname(path).toLowerCase()] ?? null
}

function extensionFor(url: string): string {
  try {
    const extension = extname(new URL(url).pathname)
    return /^\.[a-z0-9]{2,5}$/i.test(extension) ? extension.toLowerCase() : ''
  } catch {
    return ''
  }
}
