import { createHash, randomBytes } from 'node:crypto'
import { and, asc, eq, isNull } from 'drizzle-orm'
import {
  roomConfigSchema,
  roomStatusSchema,
  type RoomConfig,
  type RoomConfigInput,
  type RoomStatus,
} from '@cloudnord/contract'
import { deviceRequest, room, roomDevice, roomState, sessionOverride } from '@cloudnord/db/hub'
import type { HubDatabase } from '../db.js'

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

  overrides(sessionIds?: string[]) {
    const rows = this.db.select().from(sessionOverride).all()
    return rows
      .filter((row) => sessionIds == null || sessionIds.includes(row.sessionId))
      .map((row) => ({
        sessionId: row.sessionId,
        status: row.status as 'delayed' | 'cancelled' | 'moved',
        delayMinutes: row.delayMinutes,
        note: row.note,
      }))
  }

  statuses(): RoomStatus[] {
    return this.db
      .select()
      .from(room)
      .leftJoin(roomState, eq(roomState.roomId, room.id))
      .all()
      .map(({ room: r, room_state: state }) =>
        roomStatusSchema.parse({
          roomId: r.id,
          name: r.name,
          connectivity: state?.connectivity ?? 'OFFLINE',
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
  constructor(private readonly db: HubDatabase) {}

  /** Alimenté par le hook `onDeviceAuthRequest` du plugin. */
  recordRequest(clientId: string, scope: string | undefined): void {
    const values = { clientId, scope: scope ?? null, requestedAt: new Date().toISOString() }
    this.db
      .insert(deviceRequest)
      .values(values)
      .onConflictDoUpdate({ target: deviceRequest.clientId, set: values })
      .run()
  }

  /** Demandes non encore rattachées à une salle. */
  pending() {
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
