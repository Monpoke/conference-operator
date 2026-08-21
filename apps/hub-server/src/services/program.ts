import { createHash } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import { normalizeProgram, programSchema, type Program } from '@cloudnord/program'
import { programSnapshot } from '@cloudnord/db/hub'
import type { HubDatabase } from '../db.js'

export interface Snapshot {
  contentHash: string
  program: Program
  importedAt: string
}

/** Empreinte du contenu *brut* : deux imports identiques ne créent qu'une version. */
export function hashProgramSource(rawText: string): string {
  return createHash('sha256').update(rawText).digest('hex').slice(0, 32)
}

export class ProgramService {
  constructor(private readonly db: HubDatabase) {}

  /**
   * Récupère l'export amont, le normalise et l'enregistre comme snapshot actif.
   *
   * Le JSON brut est conservé à côté du modèle normalisé : si le normaliseur
   * gagne un correctif après l'import, on rejoue sans redépendre du réseau —
   * ce qui compte le jour J, où la source peut être injoignable.
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

    return { contentHash, program, importedAt }
  }

  /** Bascule le snapshot actif. Un import raté se rollback en un appel. */
  activate(contentHash: string): void {
    this.db.transaction((tx) => {
      tx.update(programSnapshot).set({ active: false }).run()
      tx.update(programSnapshot)
        .set({ active: true })
        .where(eq(programSnapshot.contentHash, contentHash))
        .run()
    })
  }

  active(): Snapshot | null {
    const row = this.db
      .select()
      .from(programSnapshot)
      .where(eq(programSnapshot.active, true))
      .get()
    if (row == null) return null
    return {
      contentHash: row.contentHash,
      program: programSchema.parse(JSON.parse(row.programJson)),
      importedAt: row.importedAt,
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
