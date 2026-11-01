import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { MontageJobView, PartageVideo } from '@conference-operator/contract'
import { sessionConsent, videoPartage } from '@conference-operator/db/hub'
import { desc, eq } from 'drizzle-orm'
import type { HubDatabase } from '../db.js'
import { hashPin, verifyPin } from '../pin.js'

type Row = typeof videoPartage.$inferSelect

/**
 * The videos a page opens: its talk's or every talk's finished takes, the latest
 * edit of each. A speaker's refusal holds here too: password or not, a shared page
 * is a publication. `jobs` comes newest first, as the montage service lists them.
 */
export function videosDuPartage(
  sessionId: string | null,
  jobs: readonly MontageJobView[],
  refuses: ReadonlySet<string>,
): MontageJobView[] {
  const latest = new Map<string, MontageJobView>()
  for (const job of jobs) if (!latest.has(job.sidecarUploadId)) latest.set(job.sidecarUploadId, job)
  return [...latest.values()]
    .filter((job) => job.state === 'termine' && job.outputKey != null)
    .filter((job) => (sessionId == null || job.sessionId === sessionId) && !refuses.has(job.sessionId))
    .reverse()
}

export class PartagesService {
  constructor(
    private readonly db: HubDatabase,
    private readonly publicUrl: string,
  ) {}

  private view(row: Row, titleOf: (sessionId: string) => string | null): PartageVideo {
    return {
      id: row.id,
      sessionId: row.sessionId,
      title: row.sessionId == null ? null : titleOf(row.sessionId),
      url: `${this.publicUrl.replace(/\/+$/, '')}/partage/${row.id}`,
      createdAt: row.createdAt,
    }
  }

  list(titleOf: (sessionId: string) => string | null): PartageVideo[] {
    return this.db.select().from(videoPartage).orderBy(desc(videoPartage.createdAt)).all().map((row) => this.view(row, titleOf))
  }

  create(input: { sessionId: string | null; motDePasse: string; createdBy: string | null }, titleOf: (sessionId: string) => string | null): PartageVideo {
    const row: Row = {
      id: randomBytes(18).toString('base64url'),
      sessionId: input.sessionId,
      motDePasseHash: hashPin(input.motDePasse),
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
    }
    this.db.insert(videoPartage).values(row).run()
    return this.view(row, titleOf)
  }

  remove(id: string): void {
    this.db.delete(videoPartage).where(eq(videoPartage.id, id)).run()
  }

  get(id: string): Row | null {
    return this.db.select().from(videoPartage).where(eq(videoPartage.id, id)).get() ?? null
  }

  /** The talks whose speaker refused the publication. */
  refuses(): Set<string> {
    return new Set(
      this.db.select({ sessionId: sessionConsent.sessionId }).from(sessionConsent).where(eq(sessionConsent.statut, 'refuse')).all().map((row) => row.sessionId),
    )
  }

  checkPassword(row: Row, motDePasse: string): boolean {
    return verifyPin(motDePasse, row.motDePasseHash)
  }

  /** What the visitor's cookie holds: tied to the page, it dies with it. */
  pass(row: Row): string {
    return createHash('sha256').update(`${row.id}$${row.motDePasseHash}`).digest('base64url')
  }

  checkPass(row: Row, cookies: string | undefined): boolean {
    const given = cookies?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
    if (given == null) return false
    const expected = Buffer.from(this.pass(row))
    const received = Buffer.from(given)
    return expected.length === received.length && timingSafeEqual(expected, received)
  }
}

export const COOKIE = 'partage'
