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
   * Décisions **réellement appliquées**, par identifiant de créneau : le genre
   * servi, là où il diffère de celui de l'export.
   *
   * Le programme ci-dessus les porte déjà — personne n'a à les rejouer. Ce
   * relevé n'existe que pour la console, qui doit distinguer un genre décidé
   * d'un genre importé : c'est elle qui a pris la décision, et c'est chez elle
   * qu'on la retire.
   */
  overrides: Record<string, SessionKind>
}

/** Empreinte du contenu *brut* : deux imports identiques ne créent qu'une version. */
export function hashProgramSource(rawText: string): string {
  return createHash('sha256').update(rawText).digest('hex').slice(0, 32)
}

export class ProgramService {
  constructor(private readonly db: HubDatabase) {}

  /**
   * Nom de l'événement du snapshot actif, ou `null` sans programme importé.
   *
   * Passe à côté de `programSchema.parse` volontairement : c'est la seule
   * lecture du programme qui se produit à chaque rendu de page et à chaque
   * `sync`, et revalider 70 ko de zod pour en extraire une chaîne se paierait
   * sur la boucle de supervision. Mémoïsé par `contentHash` — un import change
   * le hash, donc le cache tombe de lui-même.
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

    if (this.nomCache?.contentHash !== row.contentHash) {
      let nom: string | null = null
      try {
        const brut = (JSON.parse(row.programJson) as Program).event?.name
        nom = typeof brut === 'string' && brut.trim() !== '' ? brut.trim() : null
      } catch {
        // Un snapshot illisible ne doit pas empêcher la console de s'ouvrir :
        // c'est justement là qu'on ira voir ce qui ne va pas.
        nom = null
      }
      this.nomCache = { contentHash: row.contentHash, name: nom }
    }
    return this.nomCache.name
  }

  private nomCache: { contentHash: string; name: string | null } | null = null

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
        // Un import décrit la **version importée**, pas le programme servi :
        // les décisions du jour se lisent dans `active()`, qui les applique.
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

  /**
   * Le programme tel que le hub le **sert**, décisions du jour comprises.
   *
   * Un seul point de lecture, à dessein : la salle, le mur, la console, la
   * supervision et les notifications passent tous par ici. Appliquer les
   * surcharges plus loin — dans la salle, par exemple, qui les reçoit déjà au
   * `sync` — laisserait chaque surface décider dans son coin, et la pastille de
   * la console dirait « conférence » pendant que l'écran dirait « pause ».
   *
   * Une surcharge qui dit ce que l'export dit **déjà** est ignorée, et ne
   * compte pas dans l'empreinte. C'est ce qui rend le mécanisme sûr au
   * réimport : le jour où l'export annonce enfin le speaker de la keynote, la
   * décision « c'est une conférence » devient sans objet, et le programme servi
   * redevient exactement celui du snapshot — mêmes octets, même empreinte, pas
   * de retéléchargement dans les salles.
   *
   * Les pauses communes se projettent **après** les décisions, et pour cette
   * raison : déclarer un créneau « break » ici doit le faire apparaître dans les
   * salles libres au même moment, et le rendre à « conférence » l'en retirer.
   * L'inverse — projeter d'abord — aurait figé la projection sur ce que disait
   * l'export. Rien n'en est stocké : c'est une dérivée du programme servi, elle
   * se recalcule à chaque lecture et n'entre donc pas dans l'empreinte, que ses
   * deux sources — le snapshot et les décisions — couvrent déjà.
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
        .filter((surcharge) => surcharge.status === 'talk' || surcharge.status === 'break')
        .map((surcharge) => [surcharge.sessionId, surcharge.status as SessionKind]),
    )
    /**
     * Les identifiants OpenFeedback corrigés à la main.
     *
     * Appliqués ici, au même endroit que les décisions de genre, et pour la
     * même raison : la salle dessine ses QR hors ligne depuis ce programme, et
     * la console lit le sien depuis le même. Poser la correction ailleurs
     * ferait vivre la même vérité à deux endroits, et c'est l'adresse projetée
     * devant le public qui finirait par être la mauvaise.
     */
    const corrections = new Map(
      this.db
        .select()
        .from(sessionFeedback)
        .orderBy(asc(sessionFeedback.sessionId))
        .all()
        .map((ligne) => [ligne.sessionId, ligne.feedbackId]),
    )

    if (decisions.size === 0 && corrections.size === 0) {
      return {
        contentHash: row.contentHash,
        program: applySharedBreaks(program),
        importedAt: row.importedAt,
        overrides: {},
      }
    }

    const appliquees: Record<string, SessionKind> = {}
    /** Ce qui contredit réellement l'export : le reste ne compte pas. */
    const idsAppliques: Record<string, string> = {}
    const sessions = program.sessions.map((session) => {
      const voulu = decisions.get(session.id)
      const corrige = corrections.get(session.id)
      // Une correction qui redit l'identifiant de l'export est sans objet,
      // exactement comme une décision qui redit son genre : le programme servi
      // doit rester octet pour octet celui du snapshot, sinon les salles
      // retéléchargent pour rien.
      const identifiant = corrige == null || corrige === session.id ? null : corrige
      const genre = voulu == null || voulu === session.kind ? null : voulu
      if (genre == null && identifiant == null) return session
      if (genre != null) appliquees[session.id] = genre
      if (identifiant != null) idsAppliques[session.id] = identifiant
      return {
        ...session,
        ...(genre == null ? {} : { kind: genre }),
        ...(identifiant == null ? {} : { feedbackId: identifiant }),
      }
    })

    if (Object.keys(appliquees).length === 0 && Object.keys(idsAppliques).length === 0) {
      return {
        contentHash: row.contentHash,
        program: applySharedBreaks(program),
        importedAt: row.importedAt,
        overrides: {},
      }
    }

    return {
      /**
       * Une empreinte qui bouge avec les décisions.
       *
       * Les salles ne retéléchargent le programme que si l'empreinte a changé.
       * Garder celle du snapshot laisserait une salle sur son cache, à titrer à
       * l'antenne un déjeuner qu'on vient justement de déclarer comme tel — et
       * ce sans que rien ne le signale. Les identifiants corrigés y entrent au
       * même titre : une correction que les salles ne retéléchargeraient pas
       * laisserait le QR projeté sur l'ancienne adresse, celle qu'on vient
       * justement de déclarer fausse.
       */
      contentHash: `${row.contentHash}~${empreinteDes(appliquees, idsAppliques)}`,
      program: applySharedBreaks({ ...program, sessions }),
      importedAt: row.importedAt,
      overrides: appliquees,
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
 * Empreinte courte d'un jeu de surcharges, pour dériver celle du programme
 * servi. Triée : deux jeux identiques posés dans un ordre différent doivent
 * donner la même empreinte, sinon les salles retéléchargeraient sur un
 * changement qui n'en est pas un.
 */
function empreinteDes(
  appliquees: Record<string, SessionKind>,
  idsAppliques: Record<string, string> = {},
): string {
  const trier = (entrees: Record<string, string>, prefixe: string) =>
    Object.entries(entrees)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([sessionId, valeur]) => `${prefixe}${sessionId}:${valeur}`)
  /*
   * Les deux familles sont préfixées.
   *
   * Sans préfixe, une décision et une correction portant le même couple
   * (créneau, valeur) donneraient la même chaîne — improbable, mais une
   * empreinte qui confond deux états différents est un bogue qu'on ne
   * découvrirait qu'en salle, sur un cache qui refuse de se rafraîchir.
   */
  const trie = [...trier(appliquees, 'k:'), ...trier(idsAppliques, 'f:')].join(',')
  return createHash('sha256').update(trie).digest('hex').slice(0, 8)
}
