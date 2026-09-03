import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { assetCache } from '@cloudnord/db/client'
import { assetUrls, type Program } from '@cloudnord/program'
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
    private readonly basePath = '/assets',
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
  async fetchOne(url: string, fetchImpl: typeof fetch = fetch): Promise<AssetRef> {
    const existing = this.lookup(url)
    if (existing != null) return existing

    const response = await fetchImpl(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

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

    return { sha256, localUrl: `${this.basePath}/${sha256}`, byteSize: bytes.byteLength, contentType }
  }

  /**
   * Prefetches all of a program's assets.
   *
   * Never throws: a missing logo must not stop the room from starting. The
   * failures are returned so they can be displayed in the control app.
   */
  async prefetch(program: Program, fetchImpl: typeof fetch = fetch): Promise<PrefetchReport> {
    const report: PrefetchReport = { downloaded: 0, reused: 0, failed: [] }

    for (const url of assetUrls(program)) {
      if (this.lookup(url) != null) {
        report.reused += 1
        continue
      }
      try {
        await this.fetchOne(url, fetchImpl)
        report.downloaded += 1
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

  async read(sha256: string): Promise<{ bytes: Buffer; contentType: string | null } | null> {
    const path = this.fileFor(sha256)
    if (path == null) return null
    const row = this.store.db.select().from(assetCache).where(eq(assetCache.sha256, sha256)).get()
    return { bytes: await readFile(path), contentType: row?.contentType ?? null }
  }
}

/** Keeps the original extension: OBS and the browsers still rely on it. */
function extensionFor(url: string): string {
  try {
    const extension = extname(new URL(url).pathname)
    return /^\.[a-z0-9]{2,5}$/i.test(extension) ? extension.toLowerCase() : ''
  } catch {
    return ''
  }
}
