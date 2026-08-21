# Spike oRPC v2 — résultats

**Statut : validé, 8/8.** `pnpm --filter @cloudnord/spike-orpc-v2 spike`

Version épinglée : `2.0.0-beta.29` (beta publique ; `1.15.0` reste la ligne stable).
Documentation : **`v2.orpc.dev`** — `orpc.dev` sert la v1 et diverge sur des points
qui comptent ici.

Ce spike est **jetable**. Il existe pour lever le risque « beta récente » avant
d'écrire `packages/contract`, et pour figer les détails d'API ci-dessous.

## Ce qui est confirmé

| Vérification | Résultat |
|---|---|
| Contrat unique (`oc` + zod) partagé par les 3 transports | ✅ |
| Adapter HTTP/Fastify (hub ↔ admin, wall-web) | ✅ |
| Adapter WebSocket (hub ↔ room-client) | ✅ |
| Adapter MessagePort (Electron main ↔ renderers) | ✅ |
| Event Iterator sur WebSocket **et** MessagePort | ✅ |
| Reconnexion automatique après coupure | ✅, proactive |
| Reprise de flux sans trou ni doublon | ✅ via `lastEventId` |

## Question ouverte du plan : tranchée

> « oRPC propose un mécanisme de reprise d'Event Iterator (type `lastEventId`) —
> s'il couvre proprement notre besoin, on s'aligne dessus plutôt que de doubler
> la logique avec notre `sinceSeq`. »

**Il le couvre. On s'aligne dessus, `sinceSeq` disparaît du contrat.**

Le mécanisme complet, vérifié de bout en bout :

1. Le serveur estampille chaque événement avec son `seq` :
   `yield withEventMeta(command, { id: String(command.seq) })`
2. Le handler reçoit `lastEventId` dans ses options et reprend au bon endroit :
   `const from = lastEventId != null ? Number(lastEventId) : 0`
3. Le client peut le fournir explicitement — `client.rooms.commands(input, { lastEventId })` —
   et le `RetryLinkPlugin` (`@orpc/client/plugins`) le fait automatiquement à la reprise.

Mesuré : flux interrompu après les seq `[1,2]` → reprise sur `[3,4,5]`. Ni trou ni doublon.

**Ce que ça ne change pas** : `lastEventId` couvre le sens **descendant** (inbox).
L'outbox montante reste entièrement à notre charge — persistance SQLite, backoff,
politiques `required`/`best-effort`, idempotence serveur sur `(roomId, eventId)`.
Le spike vérifie d'ailleurs cette idempotence côté handler : un rejeu de batch
renvoie `duplicates` au lieu de ré-ingérer.

## Pièges d'API à connaître avant d'écrire le contrat

**1. Le lien WebSocket prend une *fabrique*, pas un socket.**
La doc v1 fait passer une instance ; en v2 c'est `connect: (info) => WebSocketLike`,
rappelée à chaque tentative — c'est ce qui rend la reconnexion possible.

```ts
new RPCLink({
  connect: () => new WebSocket(url),
  reconnect: {
    enabled: true,                                    // false par défaut
    delay: info => info.attempt === 1 ? 0 : 2_000,
    maxAttempt: Infinity,
    onClose: { enabled: true, delay: 0 },             // reconnecte dès la fermeture
  },
})
```

`onClose.enabled` est le bon réglage en salle : la reconnexion part dès la
fermeture du socket au lieu d'attendre le prochain appel, ce qui raccourcit la
fenêtre pendant laquelle une commande d'urgence resterait en attente. Vérifié :
après un `terminate()` serveur, le lien s'est rouvert **sans** qu'un appel le déclenche.

**2. ⚠️ Un socket `ws` sans listener `error` tue le process.**
Le piège le plus coûteux du spike. Une tentative de reconnexion vers un hub
injoignable émet un `error` non géré → `Unhandled 'error' event` → crash.
En salle, ça veut dire **perdre la régie sur une simple coupure réseau**, soit
exactement le scénario que toute l'architecture cherche à absorber.

```ts
connect: () => {
  const socket = new WebSocket(url)
  socket.on('error', (cause) => log.warn({ cause }, 'socket hub'))  // NON NÉGOCIABLE
  return socket
}
```

**3. Le lien fetch sépare `origin` et `url` (rupture v1→v2).**
`url` est typé `StandardUrl`, c'est-à-dire un *chemin* commençant par `/`.
Passer une URL absolue ne compile pas.

```ts
new RPCLink({ origin: 'https://hub.example', url: '/rpc' })   // v2
new RPCLink({ url: 'https://hub.example/rpc' })               // v1 — ne compile plus
```

**4. Fastify doit rendre le corps brut à oRPC.**
Sans ça, Fastify consomme le body avant le handler :

```ts
app.removeAllContentTypeParsers()
app.addContentTypeParser('*', (_req, _payload, done) => done(null))
app.all('/rpc/*', async (request, reply) => {
  const { matched } = await handler.handle(request, reply, { prefix: '/rpc', context: {} })
  if (!matched) await reply.status(404).send({ error: 'not found' })
})
```

**5. Ordre de fermeture.** `wss.close()` attend la déconnexion de ses clients :
fermer les sockets clients d'abord, sinon interblocage. Et en fin de run il reste
un `Timeout` plus les `MessagePort` accrochés à la boucle d'événements — à traiter
explicitement dans le `before-quit` d'Electron, sous peine d'une app qui ne se
ferme pas.

## Conséquences pour `packages/contract`

- Contrat unique en `oc` + zod, un seul router implémenté via `implement(contract)`,
  monté sur les trois adapters — aucune duplication constatée.
- `rooms.commands` : Event Iterator estampillé par `seq`, **sans paramètre `sinceSeq`**.
- `ingest.push` : batch idempotent, réponse `{ acked, duplicates }`.
- Prévoir `RetryLinkPlugin` côté room-client pour la reprise automatique du flux.
