import { z } from 'zod'
import { ROOM_STATES } from '@cloudnord/room-state'
import { sessionSchema } from '@cloudnord/program'
import {
  connectivitySchema,
  displayModeSchema,
  isoDateTimeSchema,
  roomIdSchema,
  sceneRoleSchema,
  sessionIdSchema,
} from './primitives.js'
import { eventIdentitySchema } from './event-identity.js'
import { sessionStatusSchema } from './room-state.js'

/**
 * La régie mobile : piloter une salle depuis un téléphone, par le hub.
 *
 * L'écran de régie d'une salle parle à sa propre machine — SSE pour l'état,
 * `POST /control/action` pour les gestes, le tout sur `127.0.0.1`. Un opérateur
 * qui n'est pas devant ce clavier n'a aucune commande : la console sait
 * *regarder* une salle, pas la piloter.
 *
 * Ce module décrit la seconde porte. Elle passe par le hub, donc par le flux de
 * commandes descendant qui existe déjà : rien de neuf ne relie un téléphone à
 * une instance OBS, et la salle reste autonome — une commande qu'elle rate est
 * rattrapée à sa reconnexion, ou périme.
 */

/**
 * Au-delà, un verrou dont plus personne ne donne de nouvelles tombe seul.
 *
 * Trente secondes : assez pour traverser un tunnel de métro ou verrouiller son
 * téléphone une minute — le battement repart au premier sondage —, assez peu
 * pour qu'une salle abandonnée ne reste pas prise pendant qu'on la cherche. La
 * reprise forcée existe pour les cas plus longs, et elle nomme qui elle
 * dépossède.
 */
export const REGIE_LOCK_TTL_MS = 30_000

/**
 * En-tête par lequel un onglet de régie mobile s'identifie.
 *
 * Le verrou porte une **session**, pas un compte. Deux onglets du même
 * opérateur — le téléphone dans la poche et la tablette posée sur la table —
 * pilotaient sinon la même salle en se croyant seuls, ce qui est exactement la
 * situation que le verrou existe pour supprimer. L'adresse reste ce qu'on
 * affiche ; c'est cet identifiant-là qui tranche.
 *
 * Un en-tête plutôt qu'un champ d'entrée, sur le modèle de `x-room-client-id` :
 * il concerne trois procédures et n'a rien à faire dans la charge utile de
 * chacune.
 */
export const REGIE_SESSION_HEADER = 'x-regie-session'

/**
 * Qui tient la régie mobile d'une salle.
 *
 * `expiresAt` est **calculé** (`lastSeenAt + REGIE_LOCK_TTL_MS`) et non stocké :
 * un verrou périmé n'est jamais rendu, même quand sa ligne traîne encore en
 * base. C'est la règle que le dépôt applique partout où un état se déduit —
 * `roomConferenceState` ne se stocke pas davantage.
 */
export const regieLockSchema = z.object({
  roomId: roomIdSchema,
  /** L'adresse de l'opérateur, comme `decidedBy` : c'est le seul mot qui répond à « qui a fait ça ». */
  holder: z.string(),
  /**
   * L'onglet qui tient la salle. C'est lui qui décide, pas l'adresse.
   *
   * Rendu au client pour qu'il sache s'il est ce porteur-là : « c'est vous »
   * et « c'est vous, ailleurs » n'appellent pas la même page — la seconde
   * demande de reprendre, et il faut pouvoir le dire.
   */
  holderId: z.string(),
  heldSince: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
})
export type RegieLock = z.infer<typeof regieLockSchema>

/** Une salle telle que l'écran de choix la présente, verrou compris. */
export const regieRoomSchema = z.object({
  roomId: roomIdSchema,
  name: z.string(),
  conference: z.enum(ROOM_STATES),
  connectivity: connectivitySchema,
  lock: regieLockSchema.nullable(),
})
export type RegieRoom = z.infer<typeof regieRoomSchema>

/**
 * Tout ce qu'une régie mobile affiche d'une salle.
 *
 * Volontairement plus étroit que le `DisplayPayload` que sert une machine de
 * salle : le hub ne connaît ni les vumètres, ni les rushes, ni l'état détaillé
 * des deux OBS. Il connaît le programme, le cycle de vie, l'horloge qui fait
 * foi, et ce que la salle a remonté par son battement — ce qui suffit
 * exactement au périmètre retenu.
 *
 * Tout ce qui dépend du temps est calculé **ici**, jamais dans le navigateur :
 * l'horloge du hub peut être simulée, et en développement l'écart se compte en
 * semaines.
 */
export const regieViewSchema = z.object({
  roomId: roomIdSchema,
  roomName: z.string(),
  /**
   * L'identité de l'événement, pour titrer la fenêtre.
   *
   * Le nom tranché par le hub, pas celui du programme : il se corrige en cours
   * de journée sans réimport, et c'est dans la barre d'onglets qu'un nom périmé
   * se remarque en premier — un opérateur qui aligne trois salles n'a que ça
   * pour les distinguer.
   */
  event: eventIdentitySchema,
  timezone: z.string(),
  serverTime: isoDateTimeSchema,
  simulatedClock: z.boolean(),

  /**
   * La salle répond-elle, et depuis quand.
   *
   * Décisif pour lire les boutons : le cycle de vie s'écrit chez le hub et
   * aboutit toujours, la scène et l'enregistrement attendent la salle. Les
   * confondre ferait croire à une panne d'un côté, ou à un succès de l'autre.
   */
  connectivity: connectivitySchema,
  lastSeenAt: isoDateTimeSchema.nullable(),

  /** L'état à huit valeurs, calculé sur l'horloge du hub. */
  conference: z.enum(ROOM_STATES),

  /**
   * La conférence que « Commencer » et « Terminer » atteignent.
   *
   * Rarement le créneau courant : entre deux talks et pendant une pause, c'est
   * la suivante qu'on veut lancer — le speaker s'installe. La règle vit dans
   * `talkToControl`, la même que déroule la régie de la salle.
   */
  targetSession: sessionSchema.nullable(),
  targetIsUpcoming: z.boolean(),
  /** Cycle de vie des conférences de la salle, par identifiant. */
  sessionStates: z.record(sessionIdSchema, sessionStatusSchema),
  /** Les créneaux de la salle, pour la ligne de temps et le compte à rebours. */
  sessions: z.array(sessionSchema),

  /** Ce que la salle a remonté d'OBS. */
  sceneRole: sceneRoleSchema.nullable(),
  recording: z.boolean(),
  streaming: z.boolean(),

  /**
   * Ce que la salle affiche, ou `null` si elle ne l'a pas encore dit.
   *
   * Il vient du battement, donc avec jusqu'à dix secondes de retard sur une
   * bascule décidée en salle — c'est le prix de ne rien inventer. `null` est
   * une vraie valeur : une salle jamais entendue n'a pas d'écran connu, et
   * allumer « Boucle » par défaut ferait dire à la page qu'elle sait quelque
   * chose qu'elle ignore.
   */
  displayMode: displayModeSchema.nullable(),

  /**
   * Les rôles d'OBS-A réellement mappés pour cette salle.
   *
   * Proposer `RELAY` à une salle qui n'en a pas donnerait un bouton dont
   * personne ne sait ce qu'il montre — et qui échouerait. La régie locale lit
   * la même chose de sa configuration.
   */
  sceneRoles: z.array(sceneRoleSchema),
  relaySourceRoomId: roomIdSchema.nullable(),
  promptRecordingOnStart: z.boolean(),
  promptRecordingOnStop: z.boolean(),
  sceneOnStart: sceneRoleSchema.nullable(),

  lock: regieLockSchema.nullable(),
})
export type RegieView = z.infer<typeof regieViewSchema>

/**
 * Les gestes qu'une régie mobile peut poser.
 *
 * Le cycle de vie passe par ici et non directement par `sessions.*`, alors que
 * ces procédures existent et acceptent déjà un opérateur : c'est ce qui donne
 * **une seule porte à garder**. Le verrou tient `regie.command` et rien
 * d'autre — la console garde ses gestes, et la régie de la salle n'est jamais
 * bridée par un téléphone parti dans un couloir.
 *
 * `sessionId` est explicite plutôt que déduit du programme au moment de
 * l'appel : le créneau visé peut tourner entre le rendu et le clic, et c'est
 * exactement à cet instant-là qu'une cible implicite lance le mauvais talk.
 */
export const regieCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.start'), sessionId: sessionIdSchema }),
  z.object({ type: z.literal('session.end'), sessionId: sessionIdSchema }),
  z.object({ type: z.literal('session.reset'), sessionId: sessionIdSchema }),
  z.object({ type: z.literal('scene.set'), role: sceneRoleSchema }),
  /**
   * L'écran de la salle, hors direct.
   *
   * Sans `sessionId`, là où la commande descendante en accepte un : à distance
   * on choisit un mode, pas une conférence à mettre dedans. Le hub le laisse
   * donc nul, et la salle applique le mode à ce qu'elle pilote déjà.
   */
  z.object({ type: z.literal('display.set'), mode: displayModeSchema }),
  z.object({ type: z.literal('recording.set'), on: z.boolean() }),
  z.object({ type: z.literal('stream.set'), on: z.boolean() }),
])
export type RegieCommand = z.infer<typeof regieCommandSchema>

/**
 * Ce qu'un geste a réellement obtenu.
 *
 * `now` : le hub a écrit, c'est acquis — le cycle de vie vit chez lui.
 * `queued` : la commande est partie sur le flux descendant, et c'est **tout ce
 * que le hub peut promettre**. Que la scène ait basculé se lit ensuite sur la
 * vue, pas sur cette réponse. La distinction n'est pas cosmétique : elle est ce
 * qui empêche la régie mobile de croire qu'un enregistrement a démarré parce
 * qu'un appel a répondu 200.
 */
export const regieCommandResultSchema = z.object({
  ok: z.boolean(),
  applied: z.enum(['now', 'queued']),
})
export type RegieCommandResult = z.infer<typeof regieCommandResultSchema>
