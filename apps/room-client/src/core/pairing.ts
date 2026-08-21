import { z } from 'zod'

/**
 * Appairage de la machine au hub par device authorization grant (RFC 8628).
 *
 * Écrit sans dépendance à Electron ni au réseau réel : le transport et l'attente
 * sont injectés, donc le comportement de polling est testable sans horloge murale.
 */

export const deviceCodeResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string().optional(),
  verification_uri_complete: z.string().optional(),
  /** Secondes entre deux sondages, imposées par le hub. */
  interval: z.number().int().positive().default(5),
  expires_in: z.number().int().positive().default(1800),
})
export type DeviceCodeResponse = z.infer<typeof deviceCodeResponseSchema>

export const tokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string().optional(),
})

/**
 * Codes d'erreur OAuth que le polling doit distinguer.
 *
 * `network` n'en fait pas partie : c'est le nôtre, pour un sondage qui n'a pas
 * abouti. Le hub peut redémarrer pendant qu'un opérateur se dirige vers la
 * console — perdre le code pour autant l'obligerait à recommencer sans raison.
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
  /** `scope` porte la salle demandée par la machine (`room:<id>`). */
  requestCode(clientId: string, scope?: string): Promise<unknown>
  requestToken(input: { deviceCode: string; clientId: string }): Promise<
    { ok: true; body: unknown } | { ok: false; error: string }
  >
}

export interface PairingHooks {
  /** Affiche le code à l'écran de régie dès qu'il est disponible. */
  onCode?: (response: DeviceCodeResponse) => void
  /** Chaque tentative infructueuse, pour tenir l'opérateur informé. */
  onPending?: (info: { attempt: number; nextDelayMs: number }) => void
  /** Sondage sans réponse : le hub est injoignable, le code reste valide. */
  onUnreachable?: (info: { attempt: number }) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /**
   * Interrompt l'appairage en cours.
   *
   * Sans cela, une fermeture pendant l'attente laisse la boucle sonder jusqu'à
   * l'expiration du code — une demi-heure — et l'application ne se ferme jamais.
   */
  signal?: AbortSignal
  /**
   * Salle demandée, transmise en `scope`.
   *
   * Purement indicatif : la console pré-sélectionne cette salle mais reste
   * libre d'en choisir une autre. C'est l'opérateur qui tranche, la machine ne
   * fait que proposer.
   */
  scope?: string
}

/** RFC 8628 §3.5 : sur `slow_down`, le client ajoute 5 s à sa cadence. */
const SLOW_DOWN_INCREMENT_SECONDS = 5

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Déroule l'appairage complet et rend le jeton de la machine.
 *
 * Le respect de l'intervalle n'est pas une politesse : poller plus vite renvoie
 * `slow_down`, et un client qui insiste s'auto-bloque au démarrage — précisément
 * quand l'opérateur attend devant l'écran.
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
  const interrompu = (): boolean => hooks.signal?.aborted === true

  for (;;) {
    if (interrompu()) throw new PairingError('aborted', 'Appairage interrompu')
    // Attendre *avant* le premier sondage : le hub vient d'émettre le code,
    // personne n'a encore eu le temps de l'approuver.
    const nextDelayMs = intervalSeconds * 1000
    attempt += 1
    hooks.onPending?.({ attempt, nextDelayMs })
    await sleep(nextDelayMs)
    if (interrompu()) throw new PairingError('aborted', 'Appairage interrompu')

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
        // Le hub est momentanément absent. Le code, lui, reste valide côté
        // serveur : on continue de sonder jusqu'à son expiration.
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

/** Transport HTTP réel vers les endpoints Better Auth du hub. */
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
        // Panne réseau, pas refus : le code reste valide côté hub.
        return { ok: false, error: 'network' }
      }
    },
  }
}
