import { ORPCError } from '@orpc/server'
import type { Auth } from './auth.js'
import type { ProgramService } from './services/program.js'
import type { CommandService } from './services/commands.js'
import type { IngestService } from './services/ingest.js'
import type { DeviceService, RoomService } from './services/rooms.js'
import type { QuestionService, WallService } from './services/wall.js'
import type { RateLimiter } from './services/rate-limit.js'
import type { PushService } from './services/push.js'
import type { VodService } from './services/vod.js'
import type { SessionStateService, SettingsService } from './services/sessions.js'
import type { EventIdentityService } from './services/event-identity.js'
import type { MutableClock } from './services/clock.js'
import type { ModeExecution } from '@cloudnord/contract'

export interface Services {
  programs: ProgramService
  rooms: RoomService
  devices: DeviceService
  commands: CommandService
  ingest: IngestService
  wall: WallService
  questions: QuestionService
  limiter: RateLimiter
  sessions: SessionStateService
  settings: SettingsService
  /**
   * Qui est l'événement — nom complet et nom court.
   *
   * Un service et non une constante : c'est ce qui permet au même binaire de
   * servir deux événements différents, et le nom se corrige en cours de
   * journée sans redémarrer le hub.
   */
  identity: EventIdentityService
  /**
   * Rapatriement des rushes vers S3.
   *
   * `null` quand aucun stockage n'est configuré, et c'est le cas par défaut :
   * un hub sans S3 ne doit pas porter une demi-fonctionnalité, avec une console
   * qui annonce un stockage prêt et des boutons qui échouent. Chaque procédure
   * refuse alors en le disant.
   */
  vod: VodService | null
  push: PushService
  clock: MutableClock
  /**
   * Mode d'exécution, annoncé aux salles à chaque synchronisation.
   *
   * Commande aussi ce que la console a le droit de faire : le réglage de
   * l'heure n'est ouvert qu'en développement. Un second interrupteur pour ça
   * — l'ancien `CLOCK_CONTROL` — laissait exister une combinaison absurde, un
   * hub de production dont on pouvait quand même déplacer l'horloge.
   */
  mode: ModeExecution
}

/**
 * Contexte de requête.
 *
 * `headers` est conservé tel quel : Better Auth s'en sert pour résoudre la
 * session, et les endpoints device en ont besoin pour approuver au nom de
 * l'opérateur connecté.
 */
export interface HubContext {
  auth: Auth
  services: Services
  headers: Headers
}

/**
 * Identité d'un déposant public, pour la limitation de débit.
 *
 * L'IP seule ne suffit pas : tout un public derrière le même WiFi la partage.
 * On combine donc l'IP et l'identifiant d'appareil fourni par la page.
 */
export function publicIdentity(context: HubContext, deviceId?: string | null): string {
  const ip =
    context.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    context.headers.get('x-real-ip') ??
    'inconnu'
  return `${ip}|${deviceId ?? 'sans-appareil'}`
}

export interface OperatorContext extends HubContext {
  operator: { id: string; email: string }
}

/**
 * Contexte d'une machine de salle.
 *
 * **N'étend pas `OperatorContext`** : c'est tout l'objet du changement. Une
 * salle n'agit pas au nom d'un opérateur, elle agit en son nom propre, avec des
 * droits qui s'arrêtent à sa salle.
 */
export interface RoomContext extends HubContext {
  roomId: string
  clientId: string
}

/** En-tête par lequel une machine annonce son identité d'appareil. */
export const CLIENT_ID_HEADER = 'x-room-client-id'

/**
 * Appelant d'une procédure ouverte aux deux.
 *
 * Un seul type plutôt qu'une union : oRPC infère le contexte d'un middleware à
 * partir d'une seule forme, et surtout, aplatir ici évite que chaque handler
 * ait à distinguer les cas — `roomId` non nul *est* la marque d'une salle.
 */
export interface ActorContext extends HubContext {
  operator: { id: string; email: string } | null
  roomId: string | null
  clientId: string | null
}

/** Jeton porteur présenté par l'appelant, quel qu'il soit. */
function bearer(context: HubContext): string | null {
  const entete = context.headers.get('authorization')
  if (entete == null) return null
  const [schema, valeur] = entete.split(' ')
  return schema?.toLowerCase() === 'bearer' && valeur != null ? valeur : null
}

/** Un jeton de machine se reconnaît à son préfixe, sans requête. */
export function estJetonDeSalle(context: HubContext): boolean {
  return bearer(context)?.startsWith('rt_') === true
}

export async function resolveOperator(context: HubContext): Promise<OperatorContext> {
  if (estJetonDeSalle(context)) {
    // Refus explicite plutôt que « session requise » : une machine qui tente
    // une procédure d'opérateur signale un problème, pas un oubli de connexion.
    throw new ORPCError('FORBIDDEN', {
      message: "Cette opération est réservée à la console : une machine de salle n'y a pas accès",
    })
  }

  const session = await context.auth.api.getSession({ headers: context.headers })
  if (session == null) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Session opérateur requise' })
  }
  return {
    ...context,
    operator: { id: session.user.id, email: session.user.email },
  }
}

/**
 * Session d'approbation, le temps d'un échange.
 *
 * Le seul usage légitime d'une session Better Auth par une machine : réclamer
 * son jeton de salle juste après l'appairage. Elle ne sert à rien d'autre.
 */
export async function resolveClaim(
  context: HubContext,
): Promise<OperatorContext & { clientId: string }> {
  const operator = await resolveOperator(context)
  const clientId = context.headers.get(CLIENT_ID_HEADER)
  if (clientId == null || clientId.length === 0) {
    throw new ORPCError('BAD_REQUEST', {
      message: `En-tête ${CLIENT_ID_HEADER} absent : la machine ne s'identifie pas`,
    })
  }
  return { ...operator, clientId }
}

/**
 * Résout la salle desservie par la machine appelante.
 *
 * Deux conditions distinctes, et le message doit les distinguer : une session
 * valide sans appareil appairé n'est pas la même panne qu'un appareil révoqué,
 * et l'opérateur en régie doit savoir laquelle il regarde.
 */
export async function resolveRoom(context: HubContext): Promise<RoomContext> {
  const token = bearer(context)
  if (token == null) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Jeton de salle requis' })
  }

  const machine = context.services.devices.fromToken(token)
  if (machine == null) {
    /**
     * Un message distinct de « non appairée » : ce cas se produit quand le
     * jeton a été révoqué, ou quand la base du hub a été recréée. Le client
     * doit alors relancer l'appairage, pas réessayer indéfiniment — d'où un
     * code que le client reconnaît.
     */
    throw new ORPCError('UNAUTHORIZED', {
      message: "Jeton de salle inconnu ou révoqué : réappairage nécessaire",
    })
  }

  context.services.devices.touch(machine.clientId)
  return { ...context, roomId: machine.roomId, clientId: machine.clientId }
}

/** Résout l'appelant, console ou salle, sous une forme unique. */
export async function resolveActor(context: HubContext): Promise<ActorContext> {
  if (estJetonDeSalle(context)) {
    const salle = await resolveRoom(context)
    return { ...salle, operator: null }
  }
  const operateur = await resolveOperator(context)
  return { ...operateur, roomId: null, clientId: null }
}

/** Qui a pris la décision, pour la trace d'imputabilité. */
export function auteurDe(context: ActorContext): string {
  return context.operator?.email ?? `salle:${context.roomId ?? 'inconnue'}`
}
