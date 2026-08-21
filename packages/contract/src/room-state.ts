import { z } from 'zod'
import { programSchema } from '@cloudnord/program'
import {
  connectivitySchema,
  isoDateTimeSchema,
  roomIdSchema,
  sceneRoleSchema,
  sessionIdSchema,
} from './primitives.js'

/**
 * Mapping rôle → nom de scène OBS, par salle et par instance.
 * Validé contre `GetSceneList` à la connexion : un rôle non résolu passe en rouge
 * dans la régie, pour que le problème se voie à la répétition et pas pendant un talk.
 */
export const sceneRoleMapSchema = z.object({
  A: z.partialRecord(sceneRoleSchema, z.string()),
  B: z.partialRecord(sceneRoleSchema, z.string()),
})
export type SceneRoleMap = z.infer<typeof sceneRoleMapSchema>

export const obsEndpointSchema = z.object({
  url: z.string(),
  /** Jamais transmis en clair au-delà du hub ; stocké via `safeStorage` côté client. */
  password: z.string().nullable(),
})

export const roomConfigSchema = z.object({
  id: roomIdSchema,
  name: z.string(),
  /** `event.tracks[].id` de l'export amont : c'est le lien salle ↔ programme. */
  trackId: z.string(),
  obs: z.object({ A: obsEndpointSchema, B: obsEndpointSchema }),
  sceneRoles: sceneRoleMapSchema,
  /** Port du serveur HTTP local qui sert les pages display et le cache d'assets. */
  displayPort: z.number().int().positive().default(7788),
  /** Racine des enregistrements, pour le renommage et les sidecars. */
  recordingRoot: z.string().nullable().default(null),
  /**
   * Fragment court utilisé dans les noms de fichiers (`track1`).
   * Le nom complet de la salle donnerait des noms illisibles ; à défaut on le
   * dérive, mais le renseigner rend les rushes bien plus faciles à trier.
   */
  fileSlug: z.string().max(24).nullable().default(null),
  /** Clé de diffusion RTMP, poussée par le hub au moment du sync. */
  stream: z
    .object({ rtmpUrl: z.string(), streamKey: z.string() })
    .nullable()
    .default(null),
  /**
   * Salle dont cette salle peut relayer le flux (overflow, plateau).
   *
   * Le logiciel se contente de basculer sur le rôle `RELAY` ; l'acheminement
   * lui-même (NDI ou SRT) est une affaire de configuration OBS et de réseau.
   * Ce champ sert à l'annoncer en régie : « RELAY → Track #2 » plutôt qu'un
   * bouton dont personne ne sait ce qu'il montre.
   */
  relaySourceRoomId: roomIdSchema.nullable().default(null),
})
export type RoomConfig = z.infer<typeof roomConfigSchema>

/**
 * Forme *avant* validation : les champs à valeur par défaut y sont facultatifs.
 * C'est ce qu'acceptent les écritures, pour ne pas obliger chaque appelant à
 * répéter des `null` que le schéma pose déjà.
 */
export type RoomConfigInput = z.input<typeof roomConfigSchema>

/**
 * Où en est une conférence.
 *
 * `scheduled` est l'état par défaut et n'est jamais stocké : on n'enregistre
 * que ce qui s'est produit.
 */
export const sessionStatusSchema = z.enum(['scheduled', 'running', 'ended'])
export type SessionStatus = z.infer<typeof sessionStatusSchema>

export const sessionStateSchema = z.object({
  sessionId: sessionIdSchema,
  roomId: roomIdSchema.nullable(),
  status: sessionStatusSchema,
  startedAt: isoDateTimeSchema.nullable(),
  endedAt: isoDateTimeSchema.nullable(),
  /** `auto` quand la règle horaire a clôturé le créneau, sinon l'opérateur. */
  decidedBy: z.string(),
})
export type SessionState = z.infer<typeof sessionStateSchema>

/**
 * Réglages du hub modifiables en cours d'événement.
 *
 * La clôture automatique existe parce que personne ne pense à appuyer sur
 * « Terminer » quand un talk déborde et que la salle applaudit. Le délai de
 * grâce est réglable : cinq minutes conviennent à un format de 50 minutes,
 * beaucoup moins à un quickie de 20.
 */
export const hubSettingsSchema = z.object({
  autoEndEnabled: z.boolean().default(true),
  autoEndGraceMinutes: z.number().int().min(0).max(120).default(5),
})
export type HubSettings = z.infer<typeof hubSettingsSchema>
export type HubSettingsInput = z.input<typeof hubSettingsSchema>

/**
 * État d'une conférence, enrichi du programme.
 *
 * La console ne détient pas le programme : sans ces champs, elle ne pourrait
 * afficher qu'un identifiant opaque et serait incapable de calculer le temps
 * restant. Ils sont résolus côté hub, au moment de la lecture.
 */
export const sessionStateViewSchema = sessionStateSchema.extend({
  title: z.string().nullable(),
  roomName: z.string().nullable(),
  /** Horaires **prévus** au programme, pas les horaires réels. */
  scheduledStartsAt: isoDateTimeSchema.nullable(),
  scheduledEndsAt: isoDateTimeSchema.nullable(),
})
export type SessionStateView = z.infer<typeof sessionStateViewSchema>

export const sessionOverrideSchema = z.object({
  sessionId: sessionIdSchema,
  status: z.enum(['delayed', 'cancelled', 'moved']),
  delayMinutes: z.number().int().nullable(),
  note: z.string().nullable(),
})

export const syncResultSchema = z.object({
  protocolVersion: z.number().int(),
  /** Hash du snapshot : le client ne retélécharge que s'il a changé. */
  contentHash: z.string(),
  /** Absent quand le client est déjà à jour (`since` == `contentHash`). */
  program: programSchema.nullable(),
  room: roomConfigSchema,
  overrides: z.array(sessionOverrideSchema),
  /** Base de l'offset d'horloge : les timecodes VOD en dépendent. */
  serverTime: isoDateTimeSchema,
  /**
   * L'heure du hub est simulée.
   *
   * Propagé jusqu'à l'écran de régie : voir 11:00 un matin d'août sans
   * explication ferait douter de tout le reste.
   */
  simulatedClock: z.boolean().default(false),
})

/** Vue hub d'une salle, alimentée par les heartbeats — l'écran de supervision. */
export const roomStatusSchema = z.object({
  roomId: roomIdSchema,
  name: z.string(),
  connectivity: connectivitySchema,
  lastSeenAt: isoDateTimeSchema.nullable(),
  sceneRole: sceneRoleSchema.nullable(),
  currentSessionId: sessionIdSchema.nullable(),
  recording: z.boolean(),
  streaming: z.boolean(),
  outboxDepth: z.number().int().nonnegative(),
  programContentHash: z.string().nullable(),
})
export type RoomStatus = z.infer<typeof roomStatusSchema>
