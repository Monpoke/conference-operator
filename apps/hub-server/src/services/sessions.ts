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
    const suivant = hubSettingsSchema.parse({ ...this.get(), ...patch })
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
  }

  get(sessionId: string): SessionState | null {
    const row = this.db
      .select()
      .from(sessionState)
      .where(eq(sessionState.sessionId, sessionId))
      .get()
    return row == null ? null : toState(row)
  }

  start(sessionId: string, roomId: string | null, decidedBy: string): SessionState {
    return this.write(sessionId, roomId, 'running', decidedBy)
  }

  end(sessionId: string, roomId: string | null, decidedBy: string): SessionState {
    return this.write(sessionId, roomId, 'ended', decidedBy)
  }

  /** Ramène une conférence à « à venir » — pour corriger une fausse manœuvre. */
  reset(sessionId: string): void {
    this.db.delete(sessionState).where(eq(sessionState.sessionId, sessionId)).run()
  }

  private write(
    sessionId: string,
    roomId: string | null,
    status: SessionStatus,
    decidedBy: string,
  ): SessionState {
    const maintenant = new Date(this.now()).toISOString()
    const existant = this.get(sessionId)

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

    const limite = this.now() - reglages.autoEndGraceMinutes * 60_000
    const parId = new Map(program.sessions.map((session) => [session.id, session]))
    const ended: SessionState[] = []

    for (const etat of this.states(null)) {
      if (etat.status !== 'running') continue
      const session = parId.get(etat.sessionId)
      // Session absente du programme courant (réimport, annulation) : on ne
      // décide rien, faute de créneau de référence.
      if (session?.endsAtMs == null) continue
      if (session.endsAtMs > limite) continue

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
