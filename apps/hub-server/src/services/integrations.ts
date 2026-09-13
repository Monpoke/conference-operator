import { asc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { z } from 'zod'
import { integration } from '@conference-operator/db/hub'
import type {
  IntegrationKind,
  IntegrationTestResult,
  IntegrationView,
  integrationCreateSchema,
  integrationUpdateSchema,
} from '@conference-operator/contract'
import type { HubDatabase } from '../db.js'
import { formatDelivery, type Delivery } from './integrations-format.js'
import { REACH, type PushPayload } from './push.js'

/**
 * Outgoing integrations: the supervision notices, sent to a team.
 *
 * Web Push reaches whoever subscribed a browser; a Slack or Mattermost channel
 * reaches everyone holding the day, and a generic webhook reaches whatever the
 * organisers plugged behind it. The notices and their levels are the same — an
 * integration is one more recipient, not a second set of rules.
 *
 * Deliveries are retried **in memory**: a hub restarting in the middle of a
 * retry loses that notice. Acceptable for a notice that the next pass, fifteen
 * seconds later, will have overtaken anyway; what is kept is the last success
 * and the last failure, so the console can say an integration has gone deaf.
 */

type Row = typeof integration.$inferSelect
type CreateInput = z.output<typeof integrationCreateSchema>
type UpdateInput = z.output<typeof integrationUpdateSchema>

export interface IntegrationOptions {
  /** Hub address, to link each notice to its console view. */
  publicUrl: string | null
  /** Read at send time: the name gets corrected during the day. */
  eventName: () => string
  fetchImpl?: typeof fetch
  /** Wait before each retry; its length is the number of retries. */
  retryDelaysMs?: number[]
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
}

/**
 * Three retries, over about half a minute.
 *
 * Enough to cross a Slack hiccup or a proxy restarting; beyond that, the next
 * supervision pass has something newer to say.
 */
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000]

const TIMEOUT_MS = 8_000

export class IntegrationService {
  private readonly fetchImpl: typeof fetch
  private readonly retryDelaysMs: number[]
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => Date

  constructor(
    private readonly db: HubDatabase,
    private readonly options: IntegrationOptions,
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.now = options.now ?? (() => new Date())
  }

  list(): IntegrationView[] {
    return this.db.select().from(integration).orderBy(asc(integration.createdAt)).all().map(toView)
  }

  create(input: CreateInput): IntegrationView {
    const at = this.now().toISOString()
    const row: Row = {
      id: ulid(),
      kind: input.kind,
      name: input.name,
      enabled: input.enabled,
      url: input.url,
      // Slack and Mattermost sign nothing: a secret there would suggest a
      // protection that does not exist.
      secret: input.kind === 'webhook' ? input.secret : null,
      niveauTechnique: input.levels.technique,
      niveauExploitation: input.levels.exploitation,
      createdAt: at,
      updatedAt: at,
      lastSentAt: null,
      lastErrorAt: null,
      lastError: null,
    }
    this.db.insert(integration).values(row).run()
    return toView(row)
  }

  /** `null` when the integration does not exist (any more). */
  update(input: UpdateInput): IntegrationView | null {
    const row = this.find(input.id)
    if (row == null) return null
    const next: Row = {
      ...row,
      name: input.name ?? row.name,
      url: input.url ?? row.url,
      enabled: input.enabled ?? row.enabled,
      // Absent keeps the secret, `null` removes it: the console was never given
      // it, and must be able to change a level without re-typing it.
      secret: row.kind !== 'webhook' ? null : input.secret === undefined ? row.secret : input.secret,
      niveauTechnique: input.levels?.technique ?? row.niveauTechnique,
      niveauExploitation: input.levels?.exploitation ?? row.niveauExploitation,
      updatedAt: this.now().toISOString(),
    }
    this.db.update(integration).set(next).where(eq(integration.id, row.id)).run()
    return toView(next)
  }

  remove(id: string): boolean {
    return this.db.delete(integration).where(eq(integration.id, id)).run().changes > 0
  }

  /** Enabled integrations: the supervision watch does nothing when there are none. */
  activeCount(): number {
    return this.db.select().from(integration).where(eq(integration.enabled, true)).all().length
  }

  /**
   * Sends a notice to every enabled integration whose level reaches it.
   *
   * Resolves once every delivery has succeeded or given up — retries included,
   * so up to about forty seconds. The caller does not wait for it.
   *
   * @returns Number of integrations reached.
   */
  async send(payload: PushPayload): Promise<number> {
    const wanted = REACH[payload.level] ?? 1
    const targets = this.db
      .select()
      .from(integration)
      .where(eq(integration.enabled, true))
      .all()
      .filter((row) => {
        const level = payload.family === 'technique' ? row.niveauTechnique : row.niveauExploitation
        return (REACH[level] ?? 0) >= wanted
      })
    const outcomes = await Promise.all(
      targets.map((row) => this.deliver(row, payload, this.retryDelaysMs)),
    )
    return outcomes.filter((outcome) => outcome.ok).length
  }

  /**
   * Sends a test notice, **once**, whatever its levels and even disabled.
   *
   * No retry: whoever clicks "Tester" wants the other end's answer now, not in
   * forty seconds. `null` when the integration does not exist.
   */
  async test(id: string): Promise<IntegrationTestResult | null> {
    const row = this.find(id)
    if (row == null) return null
    return this.deliver(
      row,
      {
        title: "Test de l'intégration",
        body: `« ${row.name} » est bien reliée au hub de ${this.options.eventName()}.`,
        tag: 'integration-test',
        view: 'reglages',
        family: 'technique',
        level: 'essentiel',
      },
      [],
    )
  }

  private find(id: string): Row | null {
    return this.db.select().from(integration).where(eq(integration.id, id)).get() ?? null
  }

  private async deliver(
    row: Row,
    payload: PushPayload,
    retryDelaysMs: number[],
  ): Promise<IntegrationTestResult> {
    // One delivery id and one body for every attempt: a receiver that got the
    // first one after all can recognise the retry.
    const delivery = formatDelivery(row.kind as IntegrationKind, payload, {
      publicUrl: this.options.publicUrl,
      eventName: this.options.eventName(),
      deliveryId: ulid(),
      sentAt: this.now().toISOString(),
      secret: row.secret,
    })

    let outcome = await this.attempt(row.url, delivery)
    for (const delay of retryDelaysMs) {
      if (outcome.ok || !retryable(outcome)) break
      await this.sleep(delay)
      outcome = await this.attempt(row.url, delivery)
    }
    this.record(row.id, outcome)
    return outcome
  }

  private async attempt(url: string, delivery: Delivery): Promise<IntegrationTestResult> {
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: delivery.headers,
        body: delivery.body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (response.ok) return { ok: true, status: response.status, error: null }
      // Slack says why in the body — `invalid_token`, `channel_not_found` — and
      // that word is worth more to the operator than the status code.
      const detail = (await response.text().catch(() => '')).trim().slice(0, 200)
      return {
        ok: false,
        status: response.status,
        error: `Réponse ${response.status}${detail === '' ? '' : ` : ${detail}`}`,
      }
    } catch (cause) {
      const error = cause as Error
      return {
        ok: false,
        status: null,
        error:
          error.name === 'TimeoutError'
            ? `Pas de réponse en ${TIMEOUT_MS / 1000} s`
            : `Injoignable : ${error.message}`,
      }
    }
  }

  private record(id: string, outcome: IntegrationTestResult): void {
    const at = this.now().toISOString()
    this.db
      .update(integration)
      .set(outcome.ok ? { lastSentAt: at } : { lastErrorAt: at, lastError: outcome.error })
      .where(eq(integration.id, id))
      .run()
  }
}

/**
 * Worth retrying: the network, a rate limit, the other end's own fault.
 *
 * Any other 4xx will answer the same thing in thirty seconds — a revoked
 * webhook stays revoked.
 */
function retryable(outcome: IntegrationTestResult): boolean {
  return outcome.status == null || outcome.status === 429 || outcome.status >= 500
}

/**
 * Enough of the address to recognise it, not enough to post with it.
 *
 * The secret part of a Slack or Mattermost webhook is its path: the host and
 * the last four characters give it away to nobody.
 */
export function maskUrl(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.host}/…${raw.slice(-4)}`
  } catch {
    return '…'
  }
}

function toView(row: Row): IntegrationView {
  return {
    id: row.id,
    kind: row.kind as IntegrationKind,
    name: row.name,
    enabled: row.enabled,
    url: maskUrl(row.url),
    hasSecret: row.secret != null,
    levels: {
      technique: row.niveauTechnique as IntegrationView['levels']['technique'],
      exploitation: row.niveauExploitation as IntegrationView['levels']['exploitation'],
    },
    createdAt: row.createdAt,
    lastSentAt: row.lastSentAt,
    lastErrorAt: row.lastErrorAt,
    lastError: row.lastError,
  }
}
