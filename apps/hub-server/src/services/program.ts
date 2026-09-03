import { createHash } from 'node:crypto'
import { asc, desc, eq } from 'drizzle-orm'
import {
  applySharedBreaks,
  normalizeProgram,
  programSchema,
  type Program,
  type SessionKind,
} from '@cloudnord/program'
import { programSnapshot, sessionFeedback, sessionOverride } from '@cloudnord/db/hub'
import type { HubDatabase } from '../db.js'

export interface Snapshot {
  contentHash: string
  program: Program
  importedAt: string
  /**
   * Decisions **actually applied**, by slot identifier: the kind served, where it
   * differs from the export's.
   *
   * The program above already carries them — nobody has to replay them. This
   * record only exists for the console, which has to tell a decided kind from an
   * imported one: it is the console that took the decision, and it is there that
   * it gets removed.
   */
  overrides: Record<string, SessionKind>
}

/** Fingerprint of the *raw* content: two identical imports create one version. */
export function hashProgramSource(rawText: string): string {
  return createHash('sha256').update(rawText).digest('hex').slice(0, 32)
}

export class ProgramService {
  constructor(private readonly db: HubDatabase) {}

  /**
   * Event name of the active snapshot, or `null` with no imported program.
   *
   * Deliberately bypasses `programSchema.parse`: it is the one read of the
   * program that happens on every page render and every `sync`, and revalidating
   * 70 kB of zod to extract a string would be paid for on the supervision loop.
   * Memoized by `contentHash` — an import changes the hash, so the cache falls by
   * itself.
   */
  activeEventName(): string | null {
    const row = this.db
      .select({
        contentHash: programSnapshot.contentHash,
        programJson: programSnapshot.programJson,
      })
      .from(programSnapshot)
      .where(eq(programSnapshot.active, true))
      .get()
    if (row == null) return null

    if (this.nameCache?.contentHash !== row.contentHash) {
      let name: string | null = null
      try {
        const raw = (JSON.parse(row.programJson) as Program).event?.name
        name = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
      } catch {
        // An unreadable snapshot must not stop the console from opening: that is
        // precisely where we will go and look at what is wrong.
        name = null
      }
      this.nameCache = { contentHash: row.contentHash, name }
    }
    return this.nameCache.name
  }

  private nameCache: { contentHash: string; name: string | null } | null = null

  /**
   * Fetches the upstream export, normalizes it and records it as the active
   * snapshot.
   *
   * The raw JSON is kept next to the normalized model: if the normalizer gains a
   * fix after the import, we replay it without depending on the network again —
   * which matters on the day, when the source may be unreachable.
   */
  async importFrom(sourceUrl: string, fetchImpl: typeof fetch = fetch): Promise<Snapshot> {
    const response = await fetchImpl(sourceUrl)
    if (!response.ok) {
      throw new Error(`Import du programme impossible : HTTP ${response.status} sur ${sourceUrl}`)
    }
    const rawText = await response.text()
    return this.importFromText(rawText, sourceUrl)
  }

  importFromText(rawText: string, sourceUrl: string): Snapshot {
    const contentHash = hashProgramSource(rawText)
    const existing = this.db
      .select()
      .from(programSnapshot)
      .where(eq(programSnapshot.contentHash, contentHash))
      .get()

    if (existing != null) {
      this.activate(contentHash)
      return {
        contentHash,
        program: programSchema.parse(JSON.parse(existing.programJson)),
        importedAt: existing.importedAt,
        // An import describes the **imported version**, not the served program:
        // the day's decisions are read in `active()`, which applies them.
        overrides: {},
      }
    }

    const program = normalizeProgram(JSON.parse(rawText))
    const importedAt = new Date().toISOString()

    this.db
      .insert(programSnapshot)
      .values({
        contentHash,
        sourceUrl,
        rawJson: rawText,
        programJson: JSON.stringify(program),
        sessionCount: program.sessions.length,
        issueCount: program.issues.length,
        importedAt,
        active: false,
      })
      .run()
    this.activate(contentHash)

    return { contentHash, program, importedAt, overrides: {} }
  }

  /** Switches the active snapshot. A failed import rolls back in one call. */
  activate(contentHash: string): void {
    this.db.transaction((tx) => {
      tx.update(programSnapshot).set({ active: false }).run()
      tx.update(programSnapshot)
        .set({ active: true })
        .where(eq(programSnapshot.contentHash, contentHash))
        .run()
    })
  }

  /**
   * The program as the hub **serves** it, the day's decisions included.
   *
   * A single point of reading, by design: the room, the wall, the console,
   * supervision and the notifications all go through here. Applying the overrides
   * further along — in the room, for instance, which already receives them at
   * `sync` — would let each surface decide on its own, and the console's status
   * dot would say "talk" while the screen said "break".
   *
   * An override that says what the export **already** says is ignored, and does
   * not count in the fingerprint. That is what makes the mechanism safe on a
   * reimport: the day the export finally announces the keynote's speaker, the
   * "this is a talk" decision becomes moot, and the served program becomes exactly
   * the snapshot's again — same bytes, same fingerprint, no re-download in the
   * rooms.
   *
   * Shared breaks are projected **after** the decisions, and for that reason:
   * declaring a slot a "break" here must make it appear in the free rooms at the
   * same moment, and giving it back to "talk" must remove it. The other way round
   * — projecting first — would have frozen the projection on what the export said.
   * None of it is stored: it is a derivative of the served program, recomputed on
   * every read and therefore outside the fingerprint, which its two sources — the
   * snapshot and the decisions — already cover.
   */
  active(): Snapshot | null {
    const row = this.db
      .select()
      .from(programSnapshot)
      .where(eq(programSnapshot.active, true))
      .get()
    if (row == null) return null

    const program = programSchema.parse(JSON.parse(row.programJson))
    const decisions = new Map(
      this.db
        .select()
        .from(sessionOverride)
        .orderBy(asc(sessionOverride.sessionId))
        .all()
        .filter((override) => override.status === 'talk' || override.status === 'break')
        .map((override) => [override.sessionId, override.status as SessionKind]),
    )
    /**
     * The OpenFeedback identifiers corrected by hand.
     *
     * Applied here, in the same place as the kind decisions, and for the same
     * reason: the room draws its QR codes offline from this program, and the
     * console reads its own from the same one. Putting the correction elsewhere
     * would make the same truth live in two places, and it is the address
     * projected in front of the audience that would end up being the wrong one.
     */
    const corrections = new Map(
      this.db
        .select()
        .from(sessionFeedback)
        .orderBy(asc(sessionFeedback.sessionId))
        .all()
        .map((row) => [row.sessionId, row.feedbackId]),
    )

    if (decisions.size === 0 && corrections.size === 0) {
      return {
        contentHash: row.contentHash,
        program: applySharedBreaks(program),
        importedAt: row.importedAt,
        overrides: {},
      }
    }

    const appliedKinds: Record<string, SessionKind> = {}
    /** What really contradicts the export: the rest does not count. */
    const appliedIds: Record<string, string> = {}
    const sessions = program.sessions.map((session) => {
      const wanted = decisions.get(session.id)
      const corrected = corrections.get(session.id)
      // A correction that repeats the export's identifier is moot, exactly like a
      // decision that repeats its kind: the served program must stay byte for
      // byte the snapshot's, otherwise the rooms re-download for nothing.
      const identifier = corrected == null || corrected === session.id ? null : corrected
      const kind = wanted == null || wanted === session.kind ? null : wanted
      if (kind == null && identifier == null) return session
      if (kind != null) appliedKinds[session.id] = kind
      if (identifier != null) appliedIds[session.id] = identifier
      return {
        ...session,
        ...(kind == null ? {} : { kind }),
        ...(identifier == null ? {} : { feedbackId: identifier }),
      }
    })

    if (Object.keys(appliedKinds).length === 0 && Object.keys(appliedIds).length === 0) {
      return {
        contentHash: row.contentHash,
        program: applySharedBreaks(program),
        importedAt: row.importedAt,
        overrides: {},
      }
    }

    return {
      /**
       * A fingerprint that moves with the decisions.
       *
       * The rooms only re-download the program if the fingerprint changed.
       * Keeping the snapshot's would leave a room on its cache, titling on air a
       * lunch break we have just declared as such — and with nothing to flag it.
       * The corrected identifiers enter it on the same footing: a correction the
       * rooms would not re-download would leave the projected QR code on the old
       * address, the very one we have just declared wrong.
       */
      contentHash: `${row.contentHash}~${fingerprintOf(appliedKinds, appliedIds)}`,
      program: applySharedBreaks({ ...program, sessions }),
      importedAt: row.importedAt,
      overrides: appliedKinds,
    }
  }

  list() {
    return this.db
      .select({
        contentHash: programSnapshot.contentHash,
        importedAt: programSnapshot.importedAt,
        active: programSnapshot.active,
        sessionCount: programSnapshot.sessionCount,
        issueCount: programSnapshot.issueCount,
      })
      .from(programSnapshot)
      .orderBy(desc(programSnapshot.importedAt))
      .all()
  }
}

/**
 * Short fingerprint of a set of overrides, to derive the served program's. Sorted:
 * two identical sets applied in a different order must give the same fingerprint,
 * otherwise the rooms would re-download on a change that is not one.
 */
function fingerprintOf(
  appliedKinds: Record<string, SessionKind>,
  appliedIds: Record<string, string> = {},
): string {
  const sorted = (entries: Record<string, string>, prefix: string) =>
    Object.entries(entries)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([sessionId, value]) => `${prefix}${sessionId}:${value}`)
  /*
   * Both families are prefixed.
   *
   * With no prefix, a decision and a correction carrying the same (slot, value)
   * pair would give the same string — unlikely, but a fingerprint that confuses
   * two different states is a bug you would only discover in the room, on a cache
   * that refuses to refresh.
   */
  const joined = [...sorted(appliedKinds, 'k:'), ...sorted(appliedIds, 'f:')].join(',')
  return createHash('sha256').update(joined).digest('hex').slice(0, 8)
}
