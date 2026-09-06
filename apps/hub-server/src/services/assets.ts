import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { asset } from '@conference-operator/db/hub'
import { assetUrls, type Program } from '@conference-operator/program'
import type { HubDatabase } from '../db.js'

export interface AssetFile {
  bytes: Buffer
  contentType: string | null
}

export interface AssetReport {
  downloaded: number
  reused: number
  failed: { url: string; reason: string }[]
}

/**
 * The programme's images, fetched once by the hub.
 *
 * The rooms used to download them themselves from the upstream export. That made
 * a room depend on reaching the internet, when everything else it needs already
 * comes from the hub — on an event network where only the hub goes out, the
 * projector showed broken logos. The hub now holds the bytes and serves them.
 *
 * The key is the SHA-256 of the **source URL**, and that is not an approximation:
 * it is the key the rooms already use for their own cache. Both sides name an
 * image identically without exchanging a mapping, so a room asks for
 * `/assets/<hash>` having computed the hash itself.
 *
 * What this cache is not: a mirror one revalidates. An upstream export names its
 * images by UUID — a changed photo is a new URL, so a downloaded file never goes
 * stale. Nothing here expires.
 */
export class AssetStore {
  constructor(
    private readonly db: HubDatabase,
    private readonly directory: string,
    /**
     * The ceiling on one download.
     *
     * `fetch` sets none of its own: an image server that accepts the connection
     * and then says nothing would hold the loop open with no way out.
     */
    private readonly timeoutMs = 20_000,
  ) {
    mkdirSync(directory, { recursive: true })
  }

  keyOf(url: string): string {
    return createHash('sha256').update(url).digest('hex')
  }

  private fileFor(sha256: string, sourceUrl: string): string {
    return join(this.directory, sha256 + extensionFor(sourceUrl))
  }

  /** The bytes, or `null` when this hash was never downloaded here. */
  async read(sha256: string): Promise<AssetFile | null> {
    const row = this.db.select().from(asset).where(eq(asset.sha256, sha256)).get()
    if (row == null || row.downloadedAt == null) return null

    const path = this.fileFor(sha256, row.sourceUrl)
    if (!existsSync(path)) return null
    return { bytes: await readFile(path), contentType: row.contentType }
  }

  /** How many images the hub actually holds. */
  held(): number {
    return this.db
      .select()
      .from(asset)
      .all()
      .filter((row) => row.downloadedAt != null).length
  }

  /** What the console reads: what could not be fetched, and why. */
  failures(): { url: string; reason: string; at: string }[] {
    return this.db
      .select()
      .from(asset)
      .all()
      .filter((row) => row.failedAt != null && row.downloadedAt == null)
      .map((row) => ({
        url: row.sourceUrl,
        reason: row.failureReason ?? 'inconnue',
        at: row.failedAt as string,
      }))
  }

  /**
   * Downloads what the programme names, and skips what is already held.
   *
   * Never throws: an image missing from an export must not stop a hub from
   * importing a programme. Failures are recorded rather than logged, so the
   * console can name them — the one place from which an export gets corrected.
   */
  async prefetch(program: Program, fetchImpl: typeof fetch = fetch): Promise<AssetReport> {
    const report: AssetReport = { downloaded: 0, reused: 0, failed: [] }

    for (const url of assetUrls(program)) {
      const sha256 = this.keyOf(url)
      if ((await this.read(sha256)) != null || this.adopt(sha256, url)) {
        report.reused += 1
        continue
      }
      try {
        await this.fetchOne(url, fetchImpl)
        report.downloaded += 1
      } catch (cause) {
        const reason = (cause as Error).message
        report.failed.push({ url, reason })
        this.remember(sha256, url, { failureReason: reason })
      }
    }
    return report
  }

  /**
   * Takes back a file already on disk whose row has gone.
   *
   * The index lives in the database; the bytes do not. Emptying the database —
   * which `pnpm reset:dev` does, and which happens to any hub restarted on a
   * fresh volume — would otherwise send every image to be downloaded again from
   * the upstream export, for files sitting right there. Keeping them is only
   * worth something if they are then used.
   *
   * The URL is what makes it possible: it gives the name and the extension. The
   * content type is read back from that extension rather than kept somewhere —
   * it is the same one the download would have recorded.
   */
  private adopt(sha256: string, url: string): boolean {
    const path = this.fileFor(sha256, url)
    if (!existsSync(path)) return false

    this.remember(sha256, url, {
      contentType: contentTypeFor(path),
      byteSize: statSync(path).size,
    })
    return true
  }

  private async fetchOne(url: string, fetchImpl: typeof fetch): Promise<void> {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const bytes = Buffer.from(await response.arrayBuffer())
    const sha256 = this.keyOf(url)
    const target = this.fileFor(sha256, url)

    // Written beside, then renamed: a hub killed mid-download must not leave a
    // truncated file behind a row that claims it is whole.
    const temporary = `${target}.partial`
    await writeFile(temporary, bytes)
    await rename(temporary, target)

    this.remember(sha256, url, {
      contentType: response.headers.get('content-type'),
      byteSize: bytes.byteLength,
    })
  }

  private remember(
    sha256: string,
    sourceUrl: string,
    outcome: { contentType?: string | null; byteSize?: number; failureReason?: string },
  ): void {
    const now = new Date().toISOString()
    const values =
      outcome.failureReason == null
        ? {
            contentType: outcome.contentType ?? null,
            byteSize: outcome.byteSize ?? 0,
            downloadedAt: now,
            failedAt: null,
            failureReason: null,
          }
        : { downloadedAt: null, failedAt: now, failureReason: outcome.failureReason }

    this.db
      .insert(asset)
      .values({ sha256, sourceUrl, ...values })
      .onConflictDoUpdate({ target: asset.sha256, set: values })
      .run()
  }
}

/**
 * The extension carried by the source URL, kept on disk.
 *
 * Browsers and OBS still go by it, and the file is served by name. Anything that
 * does not look like an extension is dropped rather than glued onto a filename.
 */
/**
 * The type an extension stands for.
 *
 * Only used when taking back a file whose row has gone — a downloaded file gets
 * the type the server announced. Unknown extensions get no type rather than a
 * guessed one: a browser sniffs better than this list would.
 */
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
  const extension = extname(new URL(url).pathname).toLowerCase()
  return /^\.[a-z0-9]{2,5}$/.test(extension) ? extension : ''
}
