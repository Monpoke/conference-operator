import { z } from 'zod'

/**
 * Pairing the machine to the hub through the device authorization grant
 * (RFC 8628).
 *
 * Written with no dependency on Electron or on the real network: the transport
 * and the waiting are injected, so the polling behaviour is testable with no wall
 * clock.
 */

export const deviceCodeResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string().optional(),
  verification_uri_complete: z.string().optional(),
  /** Seconds between two polls, imposed by the hub. */
  interval: z.number().int().positive().default(5),
  expires_in: z.number().int().positive().default(1800),
})
export type DeviceCodeResponse = z.infer<typeof deviceCodeResponseSchema>

export const tokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string().optional(),
})

/**
 * The OAuth error codes the polling has to tell apart.
 *
 * `network` is not one of them: it is ours, for a poll that did not go through.
 * The hub can restart while an operator walks over to the console — losing the
 * code for that would force them to start again for no reason.
 */
export type PollErrorCode =
  | 'authorization_pending'
  | 'slow_down'
  | 'access_denied'
  | 'expired_token'
  | 'invalid_grant'
  | 'network'

export class PairingError extends Error {
  constructor(
    readonly code: PollErrorCode | 'network' | 'unknown' | 'aborted',
    message: string,
  ) {
    super(message)
    this.name = 'PairingError'
  }
}

export interface PairingTransport {
  /** `scope` carries the room the machine asks for (`room:<id>`). */
  requestCode(clientId: string, scope?: string): Promise<unknown>
  requestToken(input: { deviceCode: string; clientId: string }): Promise<
    { ok: true; body: unknown } | { ok: false; error: string }
  >
}

export interface PairingHooks {
  /** Displays the code on the control screen as soon as it is available. */
  onCode?: (response: DeviceCodeResponse) => void
  /** Every unsuccessful attempt, to keep the operator informed. */
  onPending?: (info: { attempt: number; nextDelayMs: number }) => void
  /** A poll with no answer: the hub is unreachable, the code stays valid. */
  onUnreachable?: (info: { attempt: number }) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /**
   * Interrupts the pairing in progress.
   *
   * Without it, a close during the wait leaves the loop polling until the code
   * expires — half an hour — and the application never closes.
   */
  signal?: AbortSignal
  /**
   * The requested room, passed as `scope`.
   *
   * Purely indicative: the console preselects that room but stays free to choose
   * another. It is the operator who decides, the machine only proposes.
   */
  scope?: string
}

/** RFC 8628 §3.5: on `slow_down`, the client adds 5 s to its cadence. */
const SLOW_DOWN_INCREMENT_SECONDS = 5

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Runs the whole pairing and returns the machine's token.
 *
 * Honouring the interval is not a politeness: polling faster returns `slow_down`,
 * and a client that insists blocks itself at startup — precisely when the
 * operator is waiting in front of the screen.
 */
export async function runPairing(
  transport: PairingTransport,
  clientId: string,
  hooks: PairingHooks = {},
): Promise<{ accessToken: string }> {
  const sleep = hooks.sleep ?? defaultSleep
  const now = hooks.now ?? Date.now

  const code = deviceCodeResponseSchema.parse(await transport.requestCode(clientId, hooks.scope))
  hooks.onCode?.(code)

  const deadline = now() + code.expires_in * 1000
  let intervalSeconds = code.interval
  let attempt = 0
  const isAborted = (): boolean => hooks.signal?.aborted === true

  for (;;) {
    if (isAborted()) throw new PairingError('aborted', 'Appairage interrompu')
    // Wait *before* the first poll: the hub has just issued the code, nobody has
    // had time to approve it yet.
    const nextDelayMs = intervalSeconds * 1000
    attempt += 1
    hooks.onPending?.({ attempt, nextDelayMs })
    await sleep(nextDelayMs)
    if (isAborted()) throw new PairingError('aborted', 'Appairage interrompu')

    if (now() > deadline) {
      throw new PairingError('expired_token', "Le code d'appairage a expiré, relancer l'opération")
    }

    const result = await transport.requestToken({ deviceCode: code.device_code, clientId })
    if (result.ok) {
      return { accessToken: tokenResponseSchema.parse(result.body).access_token }
    }

    switch (result.error) {
      case 'authorization_pending':
        continue
      case 'network':
        // The hub is momentarily absent. The code, for its part, stays valid on
        // the server side: we keep polling until it expires.
        hooks.onUnreachable?.({ attempt })
        continue
      case 'slow_down':
        intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS
        continue
      case 'access_denied':
        throw new PairingError('access_denied', "L'opérateur a refusé cette machine")
      case 'expired_token':
        throw new PairingError('expired_token', "Le code d'appairage a expiré, relancer l'opération")
      default:
        throw new PairingError('unknown', `Appairage refusé par le hub : ${result.error}`)
    }
  }
}

/** The real HTTP transport towards the hub's Better Auth endpoints. */
export function httpPairingTransport(hubOrigin: string): PairingTransport {
  const post = async (path: string, body: unknown) => {
    const response = await fetch(new URL(path, hubOrigin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { response, body: (await response.json()) as unknown }
  }

  return {
    async requestCode(clientId, scope) {
      const { response, body } = await post('/api/auth/device/code', {
        client_id: clientId,
        ...(scope != null ? { scope } : {}),
      })
      if (!response.ok) {
        throw new PairingError('network', `Le hub a refusé la demande de code (HTTP ${response.status})`)
      }
      return body
    },
    async requestToken({ deviceCode, clientId }) {
      try {
        const { response, body } = await post('/api/auth/device/token', {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: clientId,
        })
        if (response.ok) return { ok: true, body }
        const error = (body as { error?: string } | null)?.error ?? 'unknown'
        return { ok: false, error }
      } catch {
        // A network failure, not a refusal: the code stays valid on the hub.
        return { ok: false, error: 'network' }
      }
    },
  }
}
