import { and, eq, isNull, or } from 'drizzle-orm'
import {
  hubSettingsSchema,
  sessionStateSchema,
  sessionStateViewSchema,
  type HubSettings,
  type HubSettingsInput,
  type SessionState,
  type SessionStateView,
  type SessionStatus,
} from '@cloudnord/contract'
import {
  isDecisionApplicable,
  shouldAutoEnd,
  effectiveEndInProgram,
  transitionRefusal,
  statusAfter,
  type SessionAction,
} from '@cloudnord/room-state'
import { hubSetting, sessionState } from '@cloudnord/db/hub'
import type { Program } from '@cloudnord/program'
import type { HubDatabase } from '../db.js'

const CLE_REGLAGES = 'hub'

/**
 * Réglages du hub.
 *
 * Lus à chaque usage plutôt que mis en cache : ils se modifient en cours
 * d'événement, et une valeur périmée de dix secondes sur une règle de clôture
 * automatique serait déroutante pour qui vient de la changer.
 */
export class SettingsService {
  constructor(private readonly db: HubDatabase) {}

  get(): HubSettings {
    const row = this.db.select().from(hubSetting).where(eq(hubSetting.key, CLE_REGLAGES)).get()
    if (row == null) return hubSettingsSchema.parse({})
    const parsed = hubSettingsSchema.safeParse(JSON.parse(row.valueJson))
    // Réglages corrompus : on retombe sur les valeurs par défaut plutôt que de
    // faire échouer tout ce qui en dépend.
    return parsed.success ? parsed.data : hubSettingsSchema.parse({})
  }

  update(patch: Partial<HubSettingsInput>): HubSettings {
    const courant = this.get()
    /**
     * La politique VOD se fusionne champ par champ, pas en bloc.
     *
     * Partout ailleurs, « la valeur envoyée est la valeur » : `socialLinks` est
     * une liste, et n'en envoyer qu'un élément veut bien dire qu'il n'en reste
     * qu'un. Une politique, non — c'est un panneau de réglages, et un
     * formulaire n'envoie que ce qu'il porte. Fusionnée à plat, elle repassait
     * par ses valeurs par défaut : corriger le plafond de débit en cours
     * d'événement rendait au passage `actif` à faux et la taille de part à huit
     * mégaoctets, sans que rien ne le dise. Un réglage qui se défait tout seul
     * est pire qu'un réglage absent.
     */
    const vodPolitique =
      patch.vodPolitique == null
        ? courant.vodPolitique
        : { ...courant.vodPolitique, ...patch.vodPolitique }

    const suivant = hubSettingsSchema.parse({ ...courant, ...patch, vodPolitique })
    const values = {
      key: CLE_REGLAGES,
      valueJson: JSON.stringify(suivant),
      updatedAt: new Date().toISOString(),
    }
    this.db
      .insert(hubSetting)
      .values(values)
      .onConflictDoUpdate({ target: hubSetting.key, set: values })
      .run()
    return suivant
  }
}

/**
 * Geste refusé par le cycle de vie.
 *
 * Une erreur de domaine, et pas une `ORPCError` : le service se teste et
 * s'appelle sans passer par le transport, et c'est le routeur qui sait quel
 * code HTTP dire à qui. Le message, lui, est déjà celui qu'un opérateur peut
 * lire — il vient de la table partagée avec la régie.
 */
export class TransitionRefusee extends Error {
  constructor(
    readonly depuis: SessionStatus,
    readonly action: SessionAction,
    message: string,
  ) {
    super(message)
    this.name = 'TransitionRefusee'
  }
}

export interface SweepResult {
  /** Sessions clôturées par la règle horaire lors de cette passe. */
  ended: SessionState[]
}

/**
 * Cycle de vie des conférences.
 *
 * Deux chemins mènent au même état : une décision d'opérateur, ou la règle
 * horaire. Le second existe parce que personne ne pense à appuyer sur
 * « Terminer » quand un talk déborde et que la salle applaudit.
 */
export class SessionStateService {
  constructor(
    private readonly db: HubDatabase,
    private readonly settings: SettingsService,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * États enrichis du programme.
   *
   * Le titre et les horaires prévus sont résolus ici : la console ne détient
   * pas le programme, et un identifiant opaque ne se lit pas.
   *
   * Le temps restant aussi, et pour une raison plus forte : le calculer dans le
   * navigateur revenait à le soustraire de l'heure du poste, alors que l'heure
   * qui fait foi est celle du hub — laquelle peut être simulée. La console
   * affichait donc « +6010 min » sur un talk parfaitement à l'heure dès qu'on
   * déplaçait l'horloge depuis le menu Développement.
   */
  views(roomId: string | null, program: Program | null): SessionStateView[] {
    const parId = new Map((program?.sessions ?? []).map((session) => [session.id, session]))
    const sallesParId = new Map((program?.rooms ?? []).map((salle) => [salle.id, salle.name]))
    const maintenant = this.now()

    return this.states(roomId).map((etat) => {
      const session = parId.get(etat.sessionId)
      return sessionStateViewSchema.parse({
        ...etat,
        title: session?.title ?? null,
        roomName: etat.roomId == null ? null : (sallesParId.get(etat.roomId) ?? etat.roomId),
        scheduledStartsAt: session?.startsAt ?? null,
        scheduledEndsAt: session?.endsAt ?? null,
        // `null` sur un créneau de fin inconnue, qu'on ne veut pas afficher
        // comme « 0 min ».
        remainingMs: session?.endsAtMs == null ? null : session.endsAtMs - maintenant,
      })
    })
  }

  states(roomId: string | null): SessionState[] {
    return this.db
      .select()
      .from(sessionState)
      .where(
        roomId == null
          ? undefined
          : or(eq(sessionState.roomId, roomId), isNull(sessionState.roomId)),
      )
      .all()
      .map(toState)
      .filter((etat) => this.applicable(etat))
  }

  get(sessionId: string): SessionState | null {
    const row = this.db
      .select()
      .from(sessionState)
      .where(eq(sessionState.sessionId, sessionId))
      .get()
    if (row == null) return null
    const etat = toState(row)
    return this.applicable(etat) ? etat : null
  }

  /**
   * Une décision prise *après* l'instant du hub ne s'applique pas.
   *
   * Elle appartient à une journée qui n'a pas encore eu lieu — ce qui n'arrive
   * qu'en développement, quand on recule l'horloge depuis la console. Le talk
   * de 09:50 lancé lors d'un essai à 11 h restait « en cours » en revenant à
   * 08:38 : la régie affichait « en cours » et deux heures de compte à rebours
   * sur une conférence que personne n'avait démarrée.
   *
   * On filtre à la lecture plutôt que d'effacer la ligne : ré-avancer l'horloge
   * doit retrouver la journée exactement là où on l'avait laissée. Sous une
   * horloge réelle, rien ne change — aucune décision n'est datée du futur.
   *
   * Une date illisible reste applicable : un état qu'on ne sait pas situer dans
   * le temps est un problème de données, pas une raison de le faire disparaître.
   */
  private applicable(etat: SessionState): boolean {
    const decide = etat.status === 'ended' ? etat.endedAt : etat.startedAt
    return isDecisionApplicable(decide == null ? null : Date.parse(decide), this.now())
  }

  start(sessionId: string, roomId: string | null, decidedBy: string): SessionState {
    return this.write(sessionId, roomId, 'start', decidedBy)
  }

  end(sessionId: string, roomId: string | null, decidedBy: string): SessionState {
    return this.write(sessionId, roomId, 'end', decidedBy)
  }

  /** Ramène une conférence à « à venir » — pour corriger une fausse manœuvre. */
  reset(sessionId: string): void {
    this.db.delete(sessionState).where(eq(sessionState.sessionId, sessionId)).run()
  }

  /**
   * Applique un geste, si le cycle de vie l'autorise depuis l'état constaté.
   *
   * Le service prend une **action** et non un statut : c'est la table partagée
   * qui dit ce que l'action produit, et c'est elle qui refuse. Sans ce
   * passage obligé, la régie grisait « Terminer » sur une conférence non lancée
   * pendant que cette procédure l'acceptait — on écrivait `ended` sur un talk
   * qui ne s'était pas tenu, et l'historique mentait sans que rien ne casse.
   */
  private write(
    sessionId: string,
    roomId: string | null,
    action: SessionAction,
    decidedBy: string,
  ): SessionState {
    const maintenant = new Date(this.now()).toISOString()
    const existant = this.get(sessionId)
    const depuis = existant?.status ?? 'scheduled'

    const status = statusAfter(depuis, action)
    if (status == null) {
      throw new TransitionRefusee(depuis, action, transitionRefusal(depuis, action) ?? 'Geste refusé')
    }

    const values = {
      sessionId,
      roomId,
      status,
      // On conserve l'heure de début réelle : la réécrire à la clôture ferait
      // perdre la durée effective du talk.
      startedAt: status === 'running' ? maintenant : (existant?.startedAt ?? null),
      endedAt: status === 'ended' ? maintenant : null,
      decidedBy,
      updatedAt: maintenant,
    }

    this.db
      .insert(sessionState)
      .values(values)
      .onConflictDoUpdate({ target: sessionState.sessionId, set: values })
      .run()

    return sessionStateSchema.parse(values)
  }

  /**
   * Clôture les conférences dont le créneau est dépassé.
   *
   * N'agit que sur ce qui est explicitement **en cours** : une session jamais
   * démarrée reste « à venir » plutôt que d'être déclarée terminée. Affirmer
   * qu'un talk s'est tenu alors que personne ne l'a lancé serait un mensonge
   * dans l'historique, et fausserait la VOD.
   */
  sweep(program: Program | null): SweepResult {
    const reglages = this.settings.get()
    if (!reglages.autoEndEnabled || program == null) return { ended: [] }

    const reglage = { enabled: true, graceMinutes: reglages.autoEndGraceMinutes }
    const maintenant = this.now()
    const ended: SessionState[] = []

    for (const etat of this.states(null)) {
      /**
       * La règle vit dans `@cloudnord/room-state`, et la fin qu'elle lit est
       * celle du dépassement : heure explicite, sinon durée, sinon début du
       * créneau suivant. Les deux règles parlaient d'horaires différents, et
       * une salle pouvait rester en dépassement toute la journée sans que ce
       * balayage ne la voie jamais.
       */
      const fin = effectiveEndInProgram(program, etat.sessionId)
      if (!shouldAutoEnd(fin, etat.status, maintenant, reglage)) continue
      ended.push(this.end(etat.sessionId, etat.roomId, 'auto'))
    }
    return { ended }
  }
}

function toState(row: typeof sessionState.$inferSelect): SessionState {
  return sessionStateSchema.parse({
    sessionId: row.sessionId,
    roomId: row.roomId,
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    decidedBy: row.decidedBy,
  })
}
