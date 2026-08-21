import { MessageChannel } from 'node:worker_threads'
import Fastify from 'fastify'
import { WebSocketServer, WebSocket } from 'ws'
import { createORPCClient } from '@orpc/client'
import type { ContractRouterClient } from '@orpc/contract'
import { RPCLink as FetchLink } from '@orpc/client/fetch'
import { RPCLink as WsLink } from '@orpc/client/websocket'
import { RPCLink as PortLink } from '@orpc/client/message-port'
import { RPCHandler as FastifyHandler } from '@orpc/server/fastify'
import { RPCHandler as WsHandler } from '@orpc/server/websocket'
import { RPCHandler as PortHandler } from '@orpc/server/message-port'
import { contract } from './contract.js'
import { commandLog, makeRouter, resetIngestLog } from './router.js'

type Client = ContractRouterClient<typeof contract>

const results: { name: string; ok: boolean; detail: string }[] = []
function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✓' : '  ✗'} ${name} — ${detail}`)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ─── 1. HTTP via Fastify ──────────────────────────────────────────────────────
async function spikeFastify(): Promise<void> {
  console.log('\n[1] Adapter HTTP (Fastify) — hub ↔ admin / wall-web')
  const app = Fastify()
  const handler = new FastifyHandler(makeRouter('fastify'))

  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', (_req, _payload, done) => done(null))
  app.all('/rpc/*', async (request, reply) => {
    const { matched } = await handler.handle(request, reply, { prefix: '/rpc', context: {} })
    if (!matched) await reply.status(404).send({ error: 'not found' })
  })

  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address != null ? address.port : 0

  const client: Client = createORPCClient(new FetchLink({ origin: `http://127.0.0.1:${port}`, url: '/rpc' }))
  const pong = await client.health.ping({ from: 'regie-salle-1' })
  check('appel HTTP', pong.pong === 'hello regie-salle-1', `${pong.pong} (${pong.transport})`)

  const first = await client.ingest.push({
    roomId: 'track-1',
    batch: [{ id: 'evt-a', type: 'recording.started' }, { id: 'evt-b', type: 'scene.changed' }],
  })
  const replay = await client.ingest.push({
    roomId: 'track-1',
    batch: [{ id: 'evt-b', type: 'scene.changed' }, { id: 'evt-c', type: 'talk.marker' }],
  })
  check(
    'idempotence du rejeu',
    first.acked.length === 2 && replay.acked.join() === 'evt-c' && replay.duplicates.join() === 'evt-b',
    `1er batch acked=[${first.acked}] · rejeu acked=[${replay.acked}] duplicates=[${replay.duplicates}]`,
  )

  await app.close()
}

// ─── 2 & 3. WebSocket : flux, reconnexion, reprise ────────────────────────────
async function spikeWebSocket(): Promise<void> {
  console.log('\n[2] Adapter WebSocket — hub ↔ room-client')
  resetIngestLog()
  const handler = new WsHandler(makeRouter('websocket'))
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  const serverSockets = new Set<import('ws').WebSocket>()
  wss.on('connection', (ws) => {
    serverSockets.add(ws)
    ws.on('close', () => serverSockets.delete(ws))
    handler.upgrade(ws as unknown as Parameters<typeof handler.upgrade>[0], { context: {} })
  })
  await new Promise((resolve) => wss.once('listening', resolve))
  const { port } = wss.address() as { port: number }

  let connectCount = 0
  let tearingDown = false
  const clientSockets = new Set<import('ws').WebSocket>()
  const link = new WsLink({
    connect: () => {
      connectCount += 1
      const socket = new WebSocket(`ws://127.0.0.1:${port}`)
      clientSockets.add(socket)
      socket.on('close', () => clientSockets.delete(socket))
      // ENSEIGNEMENT : sans ce listener, une tentative de reconnexion vers un
      // serveur injoignable émet un `error` non géré et tue le process. En salle,
      // ça signifie perdre la régie sur une simple coupure réseau.
      socket.on('error', (cause) => {
        if (!tearingDown) console.log(`    (socket error attendu : ${(cause as Error).message})`)
      })
      return socket as unknown as WebSocket
    },
    reconnect: {
      enabled: true,
      delay: (info) => (info.attempt === 1 ? 0 : 200),
      maxAttempt: Infinity,
      onClose: { enabled: true, delay: 0 },
    },
  })
  const client: Client = createORPCClient(link)

  const pong = await client.health.ping({ from: 'regie-salle-2' })
  check('appel WebSocket', pong.transport === 'websocket', `${pong.pong} (${pong.transport})`)

  const received: number[] = []
  for await (const command of await client.rooms.commands({ roomId: 'track-1' })) {
    received.push(command.seq)
  }
  check(
    'Event Iterator complet',
    received.join(',') === commandLog.map((c) => c.seq).join(','),
    `seq reçus = [${received}]`,
  )

  console.log('\n[3] Reconnexion après coupure réseau simulée')
  const attemptsBeforeDrop = connectCount
  for (const socket of serverSockets) socket.terminate()
  await sleep(300)
  // Avec `onClose.enabled`, oRPC a déjà rouvert le socket pendant ce sleep,
  // sans attendre le prochain appel : c'est tout l'intérêt de l'option.
  const reconnectedProactively = connectCount > attemptsBeforeDrop
  const afterDrop = await client.health.ping({ from: 'apres-coupure' })
  check(
    'reconnexion automatique',
    afterDrop.pong === 'hello apres-coupure' && reconnectedProactively,
    `appel OK après terminate() · reconnexion proactive=${reconnectedProactively} · ${connectCount} connexions au total`,
  )

  console.log('\n[4] Reprise du flux via lastEventId (question ouverte du plan)')
  const beforeCut: number[] = []
  const iterator = await client.rooms.commands({ roomId: 'track-1' })
  for await (const command of iterator) {
    beforeCut.push(command.seq)
    if (beforeCut.length === 2) break
  }

  const resumed: number[] = []
  const resumedIterator = await client.rooms.commands(
    { roomId: 'track-1' },
    { lastEventId: String(beforeCut.at(-1)) },
  )
  for await (const command of resumedIterator) resumed.push(command.seq)

  check(
    'reprise sans trou ni doublon',
    beforeCut.join(',') === '1,2' && resumed.join(',') === '3,4,5',
    `avant coupure=[${beforeCut}] → reprise=[${resumed}]`,
  )

  // Sans cette fermeture, `onClose.enabled` relance indéfiniment la connexion
  // et le process ne se termine jamais.
  // Ordre imposé : `wss.close()` attend la déconnexion de tous ses clients.
  tearingDown = true
  for (const socket of clientSockets) socket.terminate()
  for (const socket of serverSockets) socket.terminate()
  await new Promise<void>((resolve) => wss.close(() => resolve()))
}

// ─── 5. MessagePort (Electron main ↔ renderer) ────────────────────────────────
async function spikeMessagePort(): Promise<void> {
  console.log('\n[5] Adapter MessagePort — Electron main ↔ renderers')
  const handler = new PortHandler(makeRouter('message-port'))
  const { port1, port2 } = new MessageChannel()

  handler.upgrade(port1 as never, { context: {} })
  const client: Client = createORPCClient(new PortLink({ port: port2 as never }))

  const pong = await client.health.ping({ from: 'display-projector' })
  check('appel MessagePort', pong.transport === 'message-port', `${pong.pong} (${pong.transport})`)

  const streamed: number[] = []
  for await (const command of await client.rooms.commands({ roomId: 'track-1' })) {
    streamed.push(command.seq)
  }
  check('Event Iterator sur MessagePort', streamed.length === commandLog.length, `seq = [${streamed}]`)

  port1.close()
  port2.close()
}

async function main(): Promise<void> {
  console.log('Spike oRPC v2 — validation des adapters avant écriture de packages/contract')
  await spikeFastify()
  await spikeWebSocket()
  await spikeMessagePort()

  // Ce qui reste accroché à la boucle d'événements : à reproduire dans le
  // client Electron, dont le quit ne doit pas dépendre d'un timer de reconnexion.
  const lingering = process.getActiveResourcesInfo().filter((r) => r !== 'TTYWrap')
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${'─'.repeat(72)}`)
  console.log(`${results.length - failed.length}/${results.length} vérifications passées`)
  console.log(`handles encore ouverts en fin de run : ${lingering.length > 0 ? lingering.join(', ') : 'aucun'}`)
  if (failed.length > 0) {
    for (const f of failed) console.log(`  ÉCHEC — ${f.name}: ${f.detail}`)
    process.exitCode = 1
  }
  // Sortie explicite : un handle résiduel ne doit pas faire croire à un blocage.
  process.exit(process.exitCode ?? 0)
}

await main()
