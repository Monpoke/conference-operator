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
import type { ControlService } from './services/control.js'
import type { SessionStateService, SettingsService } from './services/sessions.js'
import type { EventIdentityService } from './services/event-identity.js'
import type { MutableClock } from './services/clock.js'
import type { ExecutionMode } from '@conference-operator/contract'

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
  /**
   * The mobile control lock: who is driving which room from a phone.
   *
   * A service and not a field of `rooms`: what it guards is not the room but **a
   * surface**, `regie.command`. The console and the room machine keep their
   * gestures intact.
   */
  regie: ControlService
  settings: SettingsService
  /**
   * Who the event is — full name and short name.
   *
   * A service and not a constant: that is what lets the same binary serve two
   * different events, and the name gets corrected during the day without
   * restarting the hub.
   */
  identity: EventIdentityService
  /**
   * Shipping the rushes back to S3.
   *
   * `null` when no storage is configured, and that is the default: a hub with no
   * S3 must not carry half a feature, with a console announcing storage is ready
   * and buttons that fail. Every procedure then refuses and says so.
   */
  vod: VodService | null
  push: PushService
  clock: MutableClock
  /**
   * Execution mode, announced to the rooms at every synchronization.
   *
   * It also governs what the console is allowed to do: setting the time is only
   * open in development. A second switch for that — the old `CLOCK_CONTROL` —
   * left an absurd combination possible, a production hub whose clock could
   * still be moved.
   */
  mode: ExecutionMode
}

/**
 * Request context.
 *
 * `headers` is kept as is: Better Auth uses it to resolve the session, and the
 * device endpoints need it to approve on behalf of the signed-in operator.
 */
export interface HubContext {
  auth: Auth
  services: Services
  headers: Headers
}

/**
 * Identity of a public poster, for rate limiting.
 *
 * The IP alone is not enough: a whole audience behind the same WiFi shares it.
 * So we combine the IP with the device identifier the page provides.
 */
export function publicIdentity(context: HubContext, deviceId?: string | null): string {
  const ip =
    context.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    context.headers.get('x-real-ip') ??
    'inconnu'
  return `${ip}|${deviceId ?? 'no-device'}`
}

export interface OperatorContext extends HubContext {
  operator: { id: string; email: string }
}

/**
 * A room machine's context.
 *
 * **Does not extend `OperatorContext`** — that is the whole point of the change.
 * A room does not act on behalf of an operator, it acts in its own name, with
 * rights that stop at its room.
 */
export interface RoomContext extends HubContext {
  roomId: string
  clientId: string
}

/** Header by which a machine announces its device identity. */
export const CLIENT_ID_HEADER = 'x-room-client-id'

/**
 * Caller of a procedure open to both.
 *
 * A single type rather than a union: oRPC infers a middleware's context from a
 * single shape, and above all, flattening here saves each handler from having to
 * tell the cases apart — a non-null `roomId` *is* the mark of a room.
 */
export interface ActorContext extends HubContext {
  operator: { id: string; email: string } | null
  roomId: string | null
  clientId: string | null
}

/** Bearer token presented by the caller, whoever it is. */
function bearer(context: HubContext): string | null {
  const header = context.headers.get('authorization')
  if (header == null) return null
  const [scheme, value] = header.split(' ')
  return scheme?.toLowerCase() === 'bearer' && value != null ? value : null
}

/** A machine token is recognised by its prefix, with no query. */
export function isRoomToken(context: HubContext): boolean {
  return bearer(context)?.startsWith('rt_') === true
}

export async function resolveOperator(context: HubContext): Promise<OperatorContext> {
  if (isRoomToken(context)) {
    // An explicit refusal rather than "session required": a machine attempting an
    // operator procedure signals a problem, not a forgotten sign-in.
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
 * Approval session, for the length of one exchange.
 *
 * The only legitimate use of a Better Auth session by a machine: claiming its
 * room token right after pairing. It serves nothing else.
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
 * Resolves the room the calling machine serves.
 *
 * Two distinct conditions, and the message must tell them apart: a valid session
 * with no paired device is not the same failure as a revoked device, and the
 * operator in the control room needs to know which one they are looking at.
 */
export async function resolveRoom(context: HubContext): Promise<RoomContext> {
  const token = bearer(context)
  if (token == null) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Jeton de salle requis' })
  }

  const machine = context.services.devices.fromToken(token)
  if (machine == null) {
    /**
     * A message distinct from "not paired": this case happens when the token has
     * been revoked, or when the hub's database has been recreated. The client
     * must then restart pairing, not retry indefinitely — hence a code the client
     * recognises.
     */
    throw new ORPCError('UNAUTHORIZED', {
      message: "Jeton de salle inconnu ou révoqué : réappairage nécessaire",
    })
  }

  context.services.devices.touch(machine.clientId)
  return { ...context, roomId: machine.roomId, clientId: machine.clientId }
}

/** Resolves the caller, console or room, in a single shape. */
export async function resolveActor(context: HubContext): Promise<ActorContext> {
  if (isRoomToken(context)) {
    const room = await resolveRoom(context)
    return { ...room, operator: null }
  }
  const operator = await resolveOperator(context)
  return { ...operator, roomId: null, clientId: null }
}

/** Who took the decision, for the accountability trace. */
export function authorOf(context: ActorContext): string {
  return context.operator?.email ?? `salle:${context.roomId ?? 'inconnue'}`
}
