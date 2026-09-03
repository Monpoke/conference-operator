import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { createHub, type Hub } from '../src/server.js'

/**
 * The rooms' transport survives the Vite proxy.
 *
 * `@fastify/http-proxy` installs its own `upgrade` listener and routes
 * **everything** that arrives through the Fastify router — `/ws` included, which
 * has no route there. It therefore leaves as a 404, and the proxy destroys its
 * socket at the end of the response: no room can connect while it is mounted.
 *
 * The defect lived a long time without being seen, because the proxy was only
 * mounted in the absence of a built bundle — that is, on a freshly cloned
 * repository, where nobody is surprised that a room takes a while to reach the
 * hub. It became permanent the day Vite went in front of the bundle in
 * development, which is the right order for everything else.
 */

let hub: Hub
let port: number

async function start(mode: 'dev' | 'production'): Promise<void> {
  hub = await createHub({
    port: 0,
    host: '127.0.0.1',
    databasePath: ':memory:',
    publicUrl: 'http://127.0.0.1',
    authSecret: 'test-secret-'.padEnd(48, 'x'),
    logLevel: 'fatal',
    mode,
  })
  await hub.app.listen({ port: 0, host: '127.0.0.1' })
  const address = hub.app.server.address()
  port = typeof address === 'object' && address != null ? address.port : 0
}

/** Opens a WebSocket and says what happened: accepted, or cut. */
async function attempt(path: string): Promise<'open' | 'cut'> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  try {
    return await new Promise<'open' | 'cut'>((resolve) => {
      socket.on('open', () => resolve('open'))
      socket.on('error', () => resolve('cut'))
      socket.on('close', () => resolve('cut'))
    })
  } finally {
    socket.close()
  }
}

afterEach(async () => {
  await hub.close()
})

describe('WebSocket upgrade', () => {
  it('accepts the rooms transport in development, with the proxy mounted', async () => {
    await start('dev')
    expect(await attempt('/ws')).toBe('open')
  })

  it('accepts it in production too, where no proxy is mounted', async () => {
    await start('production')
    expect(await attempt('/ws')).toBe('open')
  })

  it('cuts an address with no recipient in production', async () => {
    // Nothing else is listening: a socket left open would leak.
    await start('production')
    expect(await attempt('/inconnu')).toBe('cut')
  })
})
