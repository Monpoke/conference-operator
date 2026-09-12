import { randomBytes } from 'node:crypto'

/**
 * How long a ticket waits to be redeemed.
 *
 * The time for a page to ask and open its socket, with margin for a phone
 * network. Past that the ticket is of no use to its tab — and a ticket copied out
 * of a log is of no use to anyone else.
 */
export const SOCKET_TICKET_TTL_MS = 30_000

/** What a ticket vouches for across the upgrade. */
export interface SocketTicketGrant {
  operator: { id: string; email: string }
  regieSession: string
}

/**
 * One-shot tickets for the mobile control app's WebSocket.
 *
 * **In memory**, on purpose: a restart forgets them, and the page simply asks for
 * another — it has to reconnect anyway. Persisting them would keep valid
 * credentials on disk for no benefit.
 *
 * **Single use**: redeeming deletes. A ticket seen twice is a ticket someone
 * else has seen.
 *
 * **On the real clock**, never the hub's simulated one: "thirty seconds" is
 * elapsed time. A clock jumped forward a week in development would otherwise
 * expire every ticket on issue.
 */
export class SocketTickets {
  private readonly tickets = new Map<string, SocketTicketGrant & { expiresAtMs: number }>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = SOCKET_TICKET_TTL_MS,
  ) {}

  issue(grant: SocketTicketGrant): { ticket: string; expiresInMs: number } {
    this.purge()
    const ticket = randomBytes(32).toString('base64url')
    this.tickets.set(ticket, { ...grant, expiresAtMs: this.now() + this.ttlMs })
    return { ticket, expiresInMs: this.ttlMs }
  }

  /** What the ticket vouched for, or `null` — unknown, expired, or already used. */
  redeem(ticket: string): SocketTicketGrant | null {
    this.purge()
    const entry = this.tickets.get(ticket)
    if (entry == null) return null
    this.tickets.delete(ticket)
    return { operator: entry.operator, regieSession: entry.regieSession }
  }

  /** Unredeemed tickets would otherwise pile up: a page that asks and never opens. */
  private purge(): void {
    const now = this.now()
    for (const [ticket, entry] of this.tickets) {
      if (entry.expiresAtMs <= now) this.tickets.delete(ticket)
    }
  }
}
