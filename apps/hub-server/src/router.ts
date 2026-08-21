import { implement, withEventMeta } from '@orpc/server'
import { ORPCError } from '@orpc/server'
import {
  PROTOCOL_VERSION,
  contract,
  isCommandExpired,
  type Command,
} from '@cloudnord/contract'
import {
  auteurDe,
  publicIdentity,
  resolveActor,
  resolveClaim,
  resolveOperator,
  resolveRoom,
  type ActorContext,
  type HubContext,
} from './context.js'

const os = implement(contract).$context<HubContext>()

/** Opérateur authentifié (hub-admin). */
const operatorOnly = os.middleware(async ({ context, next }) =>
  next({ context: await resolveOperator(context) }),
)

/** Machine appairée : ajoute `roomId` au contexte. */
const roomOnly = os.middleware(async ({ context, next }) =>
  next({ context: await resolveRoom(context) }),
)

/**
 * Console **ou** machine de salle.
 *
 * Pour les procédures dont les deux ont légitimement besoin — l'état des
 * salles, le cycle de vie des conférences. Le contexte porte alors `roomId`
 * quand l'appelant est une salle, ce qui permet de borner ce qu'elle touche.
 */
const roomOrOperator = os.middleware(async ({ context, next }) =>
  next({ context: await resolveActor(context) }),
)

/**
 * Heure du hub, telle qu'elle sera propagée aux salles.
 *
 * Chaque salle mesure son offset sur cette valeur : la simuler ici déplace
 * l'ensemble du système, sans rien à régler côté salle.
 */
const nowIso = (context: HubContext) => context.services.clock.nowIso()

export const router = os.router({
  meta: {
    hello: os.meta.hello.handler(({ input, context }) => ({
      protocolVersion: PROTOCOL_VERSION,
      serverTime: nowIso(context),
      simulatedClock: context.services.clock.simulated,
      compatible: input.protocolVersion === PROTOCOL_VERSION,
    })),
  },

  program: {
    import: os.program.import
      .use(operatorOnly)
      .handler(async ({ input, context }) => {
        const snapshot = await context.services.programs.importFrom(input.sourceUrl)
        // Les salles découlent des tracks : les créer ici évite d'avoir à les
        // ressaisir, et rend la liste d'appairage utilisable immédiatement.
        context.services.rooms.ensureFromTracks(snapshot.program.rooms)
        // Prévenir les salles plutôt que d'attendre leur prochain sync : un
        // changement de programme doit atteindre l'écran en secondes.
        context.services.commands.publish(
          null,
          { type: 'program.invalidate', contentHash: snapshot.contentHash },
          null,
        )
        return snapshot
      }),
    snapshots: os.program.snapshots
      .use(operatorOnly)
      .handler(({ context }) => context.services.programs.list()),
    activate: os.program.activate.use(operatorOnly).handler(({ input, context }) => {
      context.services.programs.activate(input.contentHash)
      context.services.commands.publish(
        null,
        { type: 'program.invalidate', contentHash: input.contentHash },
        null,
      )
      return { ok: true }
    }),
  },

  rooms: {
    /** Publique : une machine non appairée doit pouvoir proposer un choix. */
    public: os.rooms.public.handler(({ context }) =>
      context.services.rooms.list().map((room) => ({ id: room.id, name: room.name })),
    ),

    list: os.rooms.list.use(operatorOnly).handler(({ context }) => context.services.rooms.list()),
    /** Lecture seule : la régie affiche l'état des autres salles. */
    statuses: os.rooms.statuses
      .use(roomOrOperator)
      .handler(({ context }) => context.services.rooms.statuses()),

    sync: os.rooms.sync.use(roomOnly).handler(({ input, context }) => {
      const room = context.services.rooms.get(context.roomId)
      if (room == null) throw new ORPCError('NOT_FOUND', { message: 'Salle introuvable' })

      const snapshot = context.services.programs.active()
      if (snapshot == null) {
        throw new ORPCError('NOT_FOUND', { message: 'Aucun programme importé sur le hub' })
      }

      // Le snapshot ne repart que s'il a changé : sur un réseau de salle poussif,
      // renvoyer 70 ko à chaque heartbeat serait du gâchis.
      const unchanged = input.since === snapshot.contentHash
      return {
        protocolVersion: PROTOCOL_VERSION,
        contentHash: snapshot.contentHash,
        program: unchanged ? null : snapshot.program,
        room,
        overrides: context.services.rooms.overrides(),
        serverTime: nowIso(context),
        simulatedClock: context.services.clock.simulated,
      }
    }),

    commands: os.rooms.commands
      .use(roomOnly)
      .handler(async function* ({ context, lastEventId, signal }) {
        const sinceSeq = parseSeq(lastEventId)
        for await (const command of context.services.commands.stream(
          context.roomId,
          sinceSeq,
          signal,
        )) {
          // Une commande rattrapée hors délai est écartée côté hub aussi : le
          // client la filtrerait de toute façon, autant ne pas l'envoyer.
          if (isExpiredNow(command)) continue
          // L'id d'événement porte le `seq` : c'est ce que le client renverra
          // en `lastEventId` à la reconnexion.
          yield withEventMeta(command, { id: String(command.seq) })
        }
      }),
  },

  sessions: {
    states: os.sessions.states.use(roomOrOperator).handler(({ input, context }) => {
      const salle = context.roomId
      // Une salle ne voit que ses conférences, quoi qu'elle demande.
      const snapshot = context.services.programs.active()
      return context.services.sessions.views(salle ?? input.roomId, snapshot?.program ?? null)
    }),

    start: os.sessions.start.use(roomOrOperator).handler(({ input, context }) => {
      const { session, roomId } = resolveSession(context, input.sessionId)
      exigerMemeSalle(context, roomId)
      const etat = context.services.sessions.start(session.id, roomId, auteurDe(context))
      diffuserEtat(context, etat)
      return etat
    }),

    end: os.sessions.end.use(roomOrOperator).handler(({ input, context }) => {
      const { session, roomId } = resolveSession(context, input.sessionId)
      exigerMemeSalle(context, roomId)
      const etat = context.services.sessions.end(session.id, roomId, auteurDe(context))
      diffuserEtat(context, etat)
      return etat
    }),

    reset: os.sessions.reset.use(roomOrOperator).handler(({ input, context }) => {
      const { session, roomId } = resolveSession(context, input.sessionId)
      exigerMemeSalle(context, roomId)
      context.services.sessions.reset(session.id)
      // La salle doit revenir à « à venir » : sans cette diffusion, son écran
      // resterait sur l'état annulé jusqu'au prochain redémarrage.
      diffuserEtat(context, {
        sessionId: session.id,
        roomId,
        status: 'scheduled',
        decidedBy: auteurDe(context),
      })
      return { ok: true }
    }),
  },

  messages: {
    send: os.messages.send.use(operatorOnly).handler(({ input, context }) => {
      if (input.roomId != null && context.services.rooms.get(input.roomId) == null) {
        throw new ORPCError('NOT_FOUND', { message: `Salle inconnue : ${input.roomId}` })
      }
      context.services.commands.publish(
        input.roomId,
        {
          type: 'message.broadcast',
          text: input.text,
          level: input.level,
          target: input.target,
          from: context.operator.email,
        },
        input.ttlSeconds,
      )
      return { ok: true }
    }),

    fromRooms: os.messages.fromRooms.use(operatorOnly).handler(({ input, context }) => {
      const salles = new Map(context.services.rooms.list().map((salle) => [salle.id, salle.name]))
      return context.services.ingest.messagesFromRooms(input.limit).map((message) => ({
        ...message,
        roomName: salles.get(message.roomId) ?? null,
      }))
    }),
  },

  clock: {
    get: os.clock.get.use(operatorOnly).handler(({ context }) => ({
      serverTime: context.services.clock.nowIso(),
      simulated: context.services.clock.simulated,
      controllable: context.services.clockControl,
    })),

    set: os.clock.set.use(operatorOnly).handler(({ input, context }) => {
      if (!context.services.clockControl) {
        throw new ORPCError('FORBIDDEN', {
          message:
            "Réglage de l'heure fermé sur ce hub. L'ouvrir avec CLOCK_CONTROL=1, " +
            "à réserver au développement : changer l'heure pendant l'événement " +
            'fausserait les timecodes des enregistrements.',
        })
      }

      try {
        context.services.clock.setSimulated(input.at)
      } catch (cause) {
        throw new ORPCError('BAD_REQUEST', { message: (cause as Error).message })
      }

      const serverTime = context.services.clock.nowIso()
      /**
       * Réaligner les salles tout de suite.
       *
       * Elles calent leur offset sur `serverTime` à chaque synchronisation :
       * sans cette diffusion, leur écran afficherait un autre moment que la
       * console jusqu'à la suivante.
       */
      context.services.commands.publish(
        null,
        { type: 'clock.changed', serverTime, simulated: context.services.clock.simulated },
        null,
      )
      return { serverTime, simulated: context.services.clock.simulated }
    }),
  },
  settings: {
    get: os.settings.get.use(operatorOnly).handler(({ context }) => context.services.settings.get()),
    update: os.settings.update
      .use(operatorOnly)
      .handler(({ input, context }) => context.services.settings.update(input)),
  },

  ingest: {
    push: os.ingest.push.use(roomOnly).handler(({ input, context }) => {
      const outcome = context.services.ingest.push(context.roomId, input.batch)
      return { ...outcome, serverTime: nowIso(context) }
    }),
  },

  devices: {
    pending: os.devices.pending
      .use(operatorOnly)
      .handler(({ context }) => context.services.devices.pending()),

    /**
     * Approbation et affectation en une seule opération.
     *
     * L'ordre compte : on approuve d'abord auprès de Better Auth, et on ne lie
     * la machine à sa salle que si l'approbation a réussi. L'inverse laisserait
     * une liaison orpheline après un code expiré.
     */
    approve: os.devices.approve.use(operatorOnly).handler(async ({ input, context }) => {
      if (context.services.rooms.get(input.roomId) == null) {
        throw new ORPCError('NOT_FOUND', { message: `Salle inconnue : ${input.roomId}` })
      }

      await context.auth.api.deviceVerify({
        query: { user_code: input.userCode },
        headers: context.headers,
      })
      await context.auth.api.deviceApprove({
        body: { userCode: input.userCode },
        headers: context.headers,
      })

      context.services.devices.bind({
        clientId: input.clientId,
        roomId: input.roomId,
        label: input.label,
        approvedByUserId: context.operator.id,
      })
      return { ok: true }
    }),

    deny: os.devices.deny.use(operatorOnly).handler(async ({ input, context }) => {
      await context.auth.api.deviceVerify({
        query: { user_code: input.userCode },
        headers: context.headers,
      })
      await context.auth.api.deviceDeny({
        body: { userCode: input.userCode },
        headers: context.headers,
      })
      return { ok: true }
    }),

    list: os.devices.list.use(operatorOnly).handler(({ context }) =>
      context.services.devices.list().map((device) => ({
        clientId: device.clientId,
        roomId: device.roomId,
        label: device.label,
        approvedAt: device.approvedAt,
        lastSeenAt: device.lastSeenAt,
        revokedAt: device.revokedAt,
      })),
    ),

    /**
     * Échange la session d'approbation contre un jeton de salle.
     *
     * Seul usage légitime d'une session Better Auth par une machine. Après
     * quoi elle jette la session : ses appels suivants ne portent plus que des
     * droits de salle.
     */
    claim: os.devices.claim.handler(async ({ context }) => {
      const { clientId } = await resolveClaim(context)
      const token = context.services.devices.issueToken(clientId)
      const roomId = context.services.devices.roomFor(clientId)
      if (token == null || roomId == null) {
        throw new ORPCError('FORBIDDEN', {
          message: 'Machine non appairée à une salle, ou appairage révoqué',
        })
      }
      return { token, roomId }
    }),

    revoke: os.devices.revoke.use(operatorOnly).handler(({ input, context }) => {
      context.services.devices.revoke(input.clientId)
      return { ok: true }
    }),
  },

  /**
   * Mur social. `post` et `feed` sont **publics** : ils servent les mobiles du
   * public, qui n'ont ni compte ni appairage. Ce sont donc les seules
   * procédures du contrat qui doivent être limitées en débit.
   */
  wall: {
    post: os.wall.post.handler(({ input, context }) => {
      if (!context.services.limiter.take(publicIdentity(context))) {
        throw new ORPCError('TOO_MANY_REQUESTS', {
          message: 'Trop de messages coup sur coup. Patientez quelques instants.',
        })
      }
      const posted = context.services.wall.post({
        source: 'form',
        author: input.author,
        text: input.text,
        roomId: input.roomId,
      })
      return { id: posted.id, status: 'pending' as const }
    }),

    feed: os.wall.feed.handler(async function* ({ input, context, lastEventId, signal }) {
      for await (const entry of context.services.wall.stream(
        input.roomId,
        parseSeq(lastEventId),
        signal,
      )) {
        yield withEventMeta(entry.comment, { id: String(entry.seq) })
      }
    }),

    pending: os.wall.pending
      .use(operatorOnly)
      .handler(({ input, context }) => context.services.wall.pending(input.source)),

    moderate: os.wall.moderate.use(operatorOnly).handler(({ input, context }) => {
      const moderated = context.services.wall.moderate(
        input.id,
        input.decision,
        context.operator.email,
      )
      if (moderated == null) throw new ORPCError('NOT_FOUND', { message: 'Message introuvable' })

      // Prévenir les salles : l'écran doit pouvoir réagir sans attendre un tic.
      if (input.decision === 'approve') {
        context.services.commands.publish(
          moderated.roomId,
          { type: 'wall.approved', commentId: moderated.id },
          3_600,
        )
      }
      return { ok: true }
    }),
  },

  questions: {
    post: os.questions.post.handler(({ input, context }) => {
      if (!context.services.limiter.take(publicIdentity(context))) {
        throw new ORPCError('TOO_MANY_REQUESTS', {
          message: 'Trop de questions coup sur coup. Patientez quelques instants.',
        })
      }
      return context.services.questions.post(input)
    }),

    vote: os.questions.vote.handler(({ input, context }) => {
      // Le seau porte sur l'appareil : le vote est le geste le plus facile à
      // automatiser, et c'est celui qui fausserait le classement.
      if (!context.services.limiter.take(publicIdentity(context, input.deviceId))) {
        throw new ORPCError('TOO_MANY_REQUESTS', { message: 'Trop de votes coup sur coup.' })
      }
      return { votes: context.services.questions.vote(input.id, input.deviceId) }
    }),

    list: os.questions.list.handler(({ input, context }) =>
      context.services.questions.list(input.roomId, input.sessionId),
    ),
  },
})

/**
 * Retrouve une session dans le programme actif.
 *
 * Refuser une session inconnue plutôt que d'écrire un état orphelin : une
 * décision portant sur un identifiant qui n'existe plus au programme serait
 * invisible partout, et donnerait l'illusion d'avoir agi.
 */
function resolveSession(
  context: { services: HubContext['services'] },
  sessionId: string,
): { session: { id: string }; roomId: string | null } {
  const snapshot = context.services.programs.active()
  const session = snapshot?.program.sessions.find((candidate) => candidate.id === sessionId)
  if (session == null) {
    throw new ORPCError('NOT_FOUND', { message: `Session inconnue au programme : ${sessionId}` })
  }
  return { session, roomId: session.roomId }
}

/**
 * Interdit à une salle de décider pour une autre.
 *
 * La console n'est pas concernée : c'est précisément son rôle de trancher à
 * distance quand un opérateur de salle n'est pas disponible.
 */
function exigerMemeSalle(context: ActorContext, roomId: string | null): void {
  if (context.roomId != null && roomId !== context.roomId) {
    throw new ORPCError('FORBIDDEN', {
      message: "Cette conférence ne se tient pas dans votre salle",
    })
  }
}

/** Prévient la salle concernée sans attendre son prochain sync. */
/**
 * Prévient **toutes** les salles, pas seulement celle concernée.
 *
 * Une régie doit pouvoir signaler « Track #2 vient de terminer » sans
 * interroger le hub : c'est ce qui permet à un opérateur d'anticiper une
 * bascule ou un enchaînement. Chaque salle filtre ensuite selon `roomId`.
 */
function diffuserEtat(
  context: { services: HubContext['services'] },
  etat: { sessionId: string; roomId: string | null; status: 'scheduled' | 'running' | 'ended'; decidedBy: string },
): void {
  const snapshot = context.services.programs.active()
  const session = snapshot?.program.sessions.find((s) => s.id === etat.sessionId)

  context.services.commands.publish(
    null,
    {
      type: 'session.state',
      sessionId: etat.sessionId,
      roomId: etat.roomId,
      sessionTitle: session?.title ?? null,
      status: etat.status,
      decidedBy: etat.decidedBy,
    },
    null,
  )
}

/** `lastEventId` est une chaîne opaque côté oRPC : on le ramène à un `seq` sûr. */
function parseSeq(lastEventId: string | undefined): number {
  if (lastEventId == null) return 0
  const seq = Number.parseInt(lastEventId, 10)
  return Number.isFinite(seq) && seq > 0 ? seq : 0
}

function isExpiredNow(command: Command): boolean {
  return isCommandExpired(command, Date.now())
}

export type Router = typeof router
