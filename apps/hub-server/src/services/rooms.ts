import { createHash, randomBytes } from 'node:crypto'
import { and, asc, eq, isNull, lt } from 'drizzle-orm'
import {
  roomConfigSchema,
  roomStatusSchema,
  type RoomConfig,
  type RoomConfigInput,
  type RoomStatus,
} from '@cloudnord/contract'
import { deviceRequest, room, roomDevice, roomState, sessionOverride } from '@cloudnord/db/hub'
import type { HubDatabase } from '../db.js'

/**
 * Silence au-delà duquel une salle est déclarée hors ligne.
 *
 * Les salles battent toutes les dix secondes ; trois battements manqués ne
 * laissent plus de doute, et restent assez courts pour qu'un opérateur le voie
 * avant de traverser le bâtiment. Sur l'horloge réelle, comme les battements
 * eux-mêmes : une heure simulée déclarerait tout le monde mort.
 */
const SILENCE_MS = 35_000

export class RoomService {
  constructor(private readonly db: HubDatabase) {}

  upsert(input: RoomConfigInput): void {
    // Normalisé à l'écriture : ce qui est stocké porte déjà tous les défauts.
    const config = roomConfigSchema.parse(input)
    const values = {
      id: config.id,
      name: config.name,
      trackId: config.trackId,
      configJson: JSON.stringify(config),
    }
    this.db
      .insert(room)
      .values(values)
      .onConflictDoUpdate({ target: room.id, set: values })
      .run()
  }

  /**
   * Crée les salles manquantes à partir des tracks du programme.
   *
   * `event.tracks[]` **sont** les salles : c'est la décision fondatrice du
   * projet, et il serait absurde de redemander à la main ce que l'export
   * contient déjà. Les salles existantes ne sont pas touchées — leur
   * configuration OBS, leur clé de diffusion et leur mapping de scènes sont
   * saisis une fois et ne doivent pas être écrasés à chaque réimport.
   */
  ensureFromTracks(tracks: { id: string; name: string }[]): { created: string[] } {
    const created: string[] = []
    for (const track of tracks) {
      if (this.get(track.id) != null) continue
      this.upsert({
        id: track.id,
        name: track.name,
        trackId: track.id,
        // Ports OBS par défaut, à ajuster par salle si les deux instances ne
        // tournent pas sur la même machine.
        obs: {
          A: { url: 'ws://127.0.0.1:4455', password: null },
          B: { url: 'ws://127.0.0.1:4456', password: null },
        },
        /**
         * Mapping par défaut plutôt que vide : une salle sans rôles n'a aucun
         * bouton fonctionnel en régie, et le message d'erreur n'arrive qu'au
         * moment où on en a besoin. Ces noms sont à ajuster par salle si OBS
         * nomme ses scènes autrement — la régie signale les rôles introuvables
         * dès la connexion.
         */
        sceneRoles: {
          A: { LIVE: 'Direct — capture HDMI', HOLD: 'Habillage — écran de salle' },
          B: {
            TALK: 'Talk — caméra + slides',
            CAM_ONLY: 'Caméra seule',
            SLIDES_ONLY: 'Slides seules',
          },
        },
      })
      created.push(track.id)
    }
    return { created }
  }

  list(): RoomConfig[] {
    return this.db
      .select()
      .from(room)
      .orderBy(asc(room.name))
      .all()
      .map((row) => roomConfigSchema.parse(JSON.parse(row.configJson)))
  }

  get(roomId: string): RoomConfig | null {
    const row = this.db.select().from(room).where(eq(room.id, roomId)).get()
    return row == null ? null : roomConfigSchema.parse(JSON.parse(row.configJson))
  }

  /**
   * Rapatrie vers le hub un projet OpenFeedback saisi jadis sur une régie.
   *
   * Le champ a été éditable dans le ⚙ de chaque salle. Il ne l'est plus — le
   * projet est une propriété de l'événement —, mais les bases existantes en
   * portent la trace, et sur le hub de développement c'était même la *seule*
   * trace : réglage d'événement vide, salle 1 renseignée, deux salles muettes.
   * Retirer le champ sans rien reprendre aurait éteint les liens de la seule
   * salle qui en avait.
   *
   * Deux gestes, dans cet ordre. Adopter, si le hub n'a rien : la valeur d'une
   * régie décrivait déjà l'événement entier, elle n'attendait qu'un endroit
   * pour le dire. Puis effacer les valeurs de salle, toutes, y compris celle
   * qu'on vient d'adopter : laisser en base un champ que plus rien ne lit est
   * la meilleure façon de le voir ressusciter au prochain refactor.
   *
   * Idempotent : au deuxième démarrage il n'y a plus rien à reprendre, et la
   * méthode ne touche pas au disque.
   */
  reprendreProjetOpenFeedback(settings: {
    get(): { openFeedbackProjectId: string | null }
    update(patch: { openFeedbackProjectId: string }): unknown
  }): { adopte: string | null; sallesNettoyees: string[] } {
    const salles = this.list()
    const portees = salles.filter(
      (salle) => (salle.openFeedbackProjectId ?? '').trim() !== '',
    )
    if (portees.length === 0) return { adopte: null, sallesNettoyees: [] }

    const duHub = (settings.get().openFeedbackProjectId ?? '').trim()
    let adopte: string | null = null
    if (duHub === '') {
      /*
       * Le plus fréquent, salles parcourues dans l'ordre de leur identifiant.
       *
       * Deux régies qui se contredisent doivent donner la même réponse à chaque
       * démarrage : une reprise qui dépendrait de l'ordre de lecture de SQLite
       * changerait de projet au redémarrage, et personne ne saurait lequel est
       * le bon.
       */
      const comptes = new Map<string, number>()
      for (const salle of [...portees].sort((a, b) => a.id.localeCompare(b.id))) {
        const projet = salle.openFeedbackProjectId!.trim()
        comptes.set(projet, (comptes.get(projet) ?? 0) + 1)
      }
      let meilleur = 0
      for (const [projet, combien] of comptes) {
        // Strict : à égalité, la première salle dans l'ordre garde la main.
        if (combien > meilleur) {
          adopte = projet
          meilleur = combien
        }
      }
      if (adopte != null) settings.update({ openFeedbackProjectId: adopte })
    }

    for (const salle of portees) {
      this.upsert({ ...salle, openFeedbackProjectId: null })
    }
    return { adopte, sallesNettoyees: portees.map((salle) => salle.id) }
  }

  overrides(sessionIds?: string[]) {
    const rows = this.db.select().from(sessionOverride).all()
    return rows
      .filter((row) => sessionIds == null || sessionIds.includes(row.sessionId))
      .map((row) => ({
        sessionId: row.sessionId,
        status: row.status as 'talk' | 'break' | 'delayed' | 'cancelled' | 'moved',
        delayMinutes: row.delayMinutes,
        note: row.note,
      }))
  }

  /**
   * Pose ou retire une décision sur un créneau.
   *
   * `null` supprime la ligne plutôt que d'enregistrer un statut « rien » : une
   * surcharge retirée doit être indistinguable d'une surcharge jamais posée,
   * sinon l'empreinte du programme servi ne reviendrait pas à sa valeur d'avant
   * et les salles retéléchargeraient pour rien.
   */
  setOverride(sessionId: string, status: 'talk' | 'break' | null): void {
    if (status == null) {
      this.db.delete(sessionOverride).where(eq(sessionOverride.sessionId, sessionId)).run()
      return
    }
    const values = {
      sessionId,
      status,
      delayMinutes: null,
      note: null,
      updatedAt: new Date().toISOString(),
    }
    this.db
      .insert(sessionOverride)
      .values(values)
      .onConflictDoUpdate({ target: sessionOverride.sessionId, set: values })
      .run()
  }

  statuses(): RoomStatus[] {
    const limite = Date.now() - SILENCE_MS
    return this.db
      .select()
      .from(room)
      .leftJoin(roomState, eq(roomState.roomId, room.id))
      .all()
      .map(({ room: r, room_state: state }) =>
        roomStatusSchema.parse({
          roomId: r.id,
          name: r.name,
          /**
           * Une salle qui s'est tue est hors ligne, quoi qu'elle ait dit en
           * dernier.
           *
           * `connectivity` est ce que la salle a **remonté** : débrancher son PC
           * laissait « ONLINE » en base pour toujours, et la console affichait
           * une salle en pleine forme dont plus personne n'avait de nouvelles.
           * Le silence est justement le symptôme qu'on veut voir.
           */
          connectivity:
            state?.lastSeenAt != null && Date.parse(state.lastSeenAt) < limite
              ? 'OFFLINE'
              : (state?.connectivity ?? 'OFFLINE'),
          lastSeenAt: state?.lastSeenAt ?? null,
          sceneRole: state?.sceneRole ?? null,
          currentSessionId: state?.currentSessionId ?? null,
          recording: state?.recording ?? false,
          streaming: state?.streaming ?? false,
          outboxDepth: state?.outboxDepth ?? 0,
          programContentHash: state?.programContentHash ?? null,
        }),
      )
  }
}

/**
 * Appairage des machines.
 *
 * Better Auth couvre l'échange de jetons (RFC 8628) mais lie l'appareil à
 * l'opérateur qui approuve. Quelle salle une machine dessert relève d'ici.
 */
export class DeviceService {
  /**
   * @param ttlMs Durée de vie d'une demande, alignée sur celle du code
   *   d'appairage (`DEVICE_CODE_TTL`). Sur l'horloge réelle, pas sur celle du
   *   hub : les codes de Better Auth expirent eux aussi en temps réel, et une
   *   heure simulée ne doit pas décider de la survie d'un appairage.
   */
  constructor(
    private readonly db: HubDatabase,
    private readonly ttlMs: number,
  ) {}

  /** Alimenté par le hook `onDeviceAuthRequest` du plugin. */
  recordRequest(clientId: string, scope: string | undefined): void {
    const values = { clientId, scope: scope ?? null, requestedAt: new Date().toISOString() }
    this.db
      .insert(deviceRequest)
      .values(values)
      .onConflictDoUpdate({ target: deviceRequest.clientId, set: values })
      .run()
  }

  /**
   * Oublie les demandes dont le code ne vaut plus rien.
   *
   * Rien ne les effaçait : une machine dont le code a expiré, ou qu'on a
   * refusée, restait dans la file jusqu'à ce que quelqu'un l'appaire — et une
   * salle réinstallée revient sous une nouvelle identité, donc une ligne de
   * plus. En développement, où chaque `DATA_DIR` neuf en produit une, la file
   * finissait par masquer la seule demande qui comptait.
   *
   * @returns Nombre de demandes oubliées, pour le journal.
   */
  purgeExpired(): number {
    const limite = new Date(Date.now() - this.ttlMs).toISOString()
    // Les horodatages sont tous en ISO 8601 UTC : l'ordre lexicographique est
    // l'ordre chronologique, et SQLite n'a pas de type date à comparer.
    return this.db.delete(deviceRequest).where(lt(deviceRequest.requestedAt, limite)).run().changes
  }

  /** Oublie une demande précise — machine refusée, ou déjà traitée. */
  forget(clientId: string): void {
    this.db.delete(deviceRequest).where(eq(deviceRequest.clientId, clientId)).run()
  }

  /**
   * Demandes non encore rattachées à une salle.
   *
   * La purge est faite ici plutôt que par un minuteur : c'est le seul appel
   * qui regarde la file, la console l'interroge toutes les dix secondes, et
   * une demande périmée que personne ne consulte ne gêne personne.
   */
  pending() {
    this.purgeExpired()
    return this.db
      .select({
        clientId: deviceRequest.clientId,
        scope: deviceRequest.scope,
        requestedAt: deviceRequest.requestedAt,
      })
      .from(deviceRequest)
      .leftJoin(roomDevice, eq(roomDevice.clientId, deviceRequest.clientId))
      .where(isNull(roomDevice.clientId))
      .orderBy(asc(deviceRequest.requestedAt))
      .all()
  }

  bind(input: {
    clientId: string
    roomId: string
    label?: string
    approvedByUserId: string
  }): void {
    const values = {
      clientId: input.clientId,
      roomId: input.roomId,
      label: input.label ?? null,
      approvedByUserId: input.approvedByUserId,
      approvedAt: new Date().toISOString(),
      revokedAt: null,
    }
    this.db
      .insert(roomDevice)
      .values(values)
      .onConflictDoUpdate({ target: roomDevice.clientId, set: values })
      .run()
    this.db.delete(deviceRequest).where(eq(deviceRequest.clientId, input.clientId)).run()
  }

  /**
   * Délivre un jeton de machine, en échange d'un appairage valide.
   *
   * C'est le pivot du modèle de droits : la session Better Auth prouve qu'un
   * opérateur a approuvé cette machine, et s'arrête là. Ce jeton-ci porte les
   * droits d'une salle — sync, commandes, remontée, cycle de vie de *ses*
   * conférences — et rien de plus.
   *
   * Le jeton n'est rendu qu'une fois ; seule son empreinte est conservée.
   */
  issueToken(clientId: string): string | null {
    const roomId = this.roomFor(clientId)
    if (roomId == null) return null

    const token = `rt_${randomBytes(32).toString('base64url')}`
    this.db
      .update(roomDevice)
      .set({ tokenHash: hashToken(token), tokenIssuedAt: new Date().toISOString() })
      .where(eq(roomDevice.clientId, clientId))
      .run()
    return token
  }

  /**
   * Résout une machine depuis son jeton.
   *
   * Comparaison sur l'empreinte : le jeton en clair n'existe nulle part côté
   * hub, donc une fuite de la base ne permet pas d'usurper une salle.
   */
  fromToken(token: string): { clientId: string; roomId: string } | null {
    if (!token.startsWith('rt_')) return null
    const row = this.db
      .select()
      .from(roomDevice)
      .where(and(eq(roomDevice.tokenHash, hashToken(token)), isNull(roomDevice.revokedAt)))
      .get()
    return row == null ? null : { clientId: row.clientId, roomId: row.roomId }
  }

  /** Salle desservie par une machine, ou `null` si inconnue ou révoquée. */
  roomFor(clientId: string): string | null {
    const row = this.db
      .select({ roomId: roomDevice.roomId })
      .from(roomDevice)
      .where(and(eq(roomDevice.clientId, clientId), isNull(roomDevice.revokedAt)))
      .get()
    return row?.roomId ?? null
  }

  list() {
    return this.db.select().from(roomDevice).orderBy(asc(roomDevice.approvedAt)).all()
  }

  revoke(clientId: string): void {
    this.db
      .update(roomDevice)
      // Le jeton part avec la révocation : le laisser en base rendrait la
      // machine réutilisable si `revoked_at` était un jour effacé par erreur.
      .set({ revokedAt: new Date().toISOString(), tokenHash: null })
      .where(eq(roomDevice.clientId, clientId))
      .run()
  }

  touch(clientId: string): void {
    this.db
      .update(roomDevice)
      .set({ lastSeenAt: new Date().toISOString() })
      .where(eq(roomDevice.clientId, clientId))
      .run()
  }

  isKnownClient(clientId: string): boolean {
    // ULID : format imposé au client, filtre le bruit avant d'écrire en base.
    return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(clientId)
  }
}

/** SHA-256 : suffisant pour un secret aléatoire de 32 octets, sans coût inutile. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
