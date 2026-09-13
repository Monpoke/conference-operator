import { describe, expect, it } from 'vitest'
import { SOCKET_TICKET_TTL_MS, SocketTickets } from '../src/services/socket-tickets.js'

const GRANT = {
  operator: { id: 'user-1', email: 'regie@cloudnord.fr', roles: ['regieMobile' as const] },
  regieSession: 'session-phone',
}

describe('socket tickets', () => {
  it('vouch for their operator and tab, once', () => {
    const tickets = new SocketTickets()
    const { ticket } = tickets.issue(GRANT)

    expect(tickets.redeem(ticket)).toEqual(GRANT)
    // A ticket seen twice is a ticket someone else has seen.
    expect(tickets.redeem(ticket)).toBeNull()
  })

  it('expire on their own', () => {
    let clock = 1_000_000
    const tickets = new SocketTickets(() => clock)
    const { ticket, expiresInMs } = tickets.issue(GRANT)
    expect(expiresInMs).toBe(SOCKET_TICKET_TTL_MS)

    clock += SOCKET_TICKET_TTL_MS
    expect(tickets.redeem(ticket)).toBeNull()
  })

  it('are not guessable from one another', () => {
    const tickets = new SocketTickets()
    const first = tickets.issue(GRANT).ticket
    const second = tickets.issue(GRANT).ticket

    expect(first).not.toBe(second)
    // 32 random bytes, base64url: 43 characters.
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(tickets.redeem('not-a-ticket')).toBeNull()
  })
})
