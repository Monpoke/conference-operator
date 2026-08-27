import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { createHub, type Hub } from '../src/server.js'

/**
 * Le transport des salles survit au proxy Vite.
 *
 * `@fastify/http-proxy` pose son propre écouteur `upgrade` et route **tout** ce
 * qui arrive par le routeur Fastify — `/ws` compris, qui n'y a pas de route.
 * Il part donc en 404, et le proxy détruit son socket à la fin de la réponse :
 * aucune salle ne peut se connecter tant qu'il est monté.
 *
 * Le défaut a vécu longtemps sans se voir, parce que le proxy ne se montait
 * qu'en l'absence de bundle construit — c'est-à-dire sur un dépôt fraîchement
 * cloné, où personne ne s'étonne qu'une salle mette du temps à joindre le hub.
 * Il est devenu permanent le jour où Vite est passé devant le bundle en
 * développement, ce qui est le bon ordre pour tout le reste.
 */

let hub: Hub
let port: number

async function demarrer(mode: 'dev' | 'production'): Promise<void> {
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

/** Ouvre un WebSocket et dit ce qui s'est passé : accepté, ou coupé. */
async function tenter(chemin: string): Promise<'ouvert' | 'coupé'> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${chemin}`)
  try {
    return await new Promise<'ouvert' | 'coupé'>((resolve) => {
      socket.on('open', () => resolve('ouvert'))
      socket.on('error', () => resolve('coupé'))
      socket.on('close', () => resolve('coupé'))
    })
  } finally {
    socket.close()
  }
}

afterEach(async () => {
  await hub.close()
})

describe('upgrade WebSocket', () => {
  it('accepte le transport des salles en développement, proxy monté', async () => {
    await demarrer('dev')
    expect(await tenter('/ws')).toBe('ouvert')
  })

  it('l’accepte aussi en production, où aucun proxy n’est monté', async () => {
    await demarrer('production')
    expect(await tenter('/ws')).toBe('ouvert')
  })

  it('coupe une adresse sans destinataire en production', async () => {
    // Rien d'autre n'écoute : un socket laissé ouvert fuirait.
    await demarrer('production')
    expect(await tenter('/inconnu')).toBe('coupé')
  })
})
