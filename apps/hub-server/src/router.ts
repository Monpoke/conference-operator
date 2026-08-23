import { implement, withEventMeta } from '@orpc/server'
import { ORPCError } from '@orpc/server'
import {
  PROTOCOL_VERSION,
  contract,
  isCommandExpired,
  type Command,
} from '@cloudnord/contract'
import {
  currentSession,
  nextSession,
  FUSEAU_PAR_DEFAUT,
  openFeedbackUrl,
  type Session,
} from '@cloudnord/program'
import { statutsDesSalles } from './supervision.js'
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

    /**
     * Le programme actif, mis à plat pour la console.
     *
     * Le hub le détient déjà ; la console, elle, ne connaissait que les
     * conférences démarrées et ne pouvait donc pas répondre à « et après, il y
     * a quoi ». Mis à plat ici plutôt que renvoyé entier : bios, logos et
     * visuels font l'essentiel des 70 ko d'un snapshot, et rien de tout ça ne
     * s'affiche dans un planning.
     */
    planning: os.program.planning.use(operatorOnly).handler(({ context }) => {
      const snapshot = context.services.programs.active()
      // Pas d'erreur : un hub tout juste installé n'a pas encore de programme,
      // et la console doit pouvoir le dire plutôt que de tomber en panne.
      if (snapshot == null) {
        return {
          contentHash: null,
          timezone: FUSEAU_PAR_DEFAUT,
          serverTime: nowIso(context),
          rooms: [],
          sessions: [],
        }
      }

      const { program } = snapshot
      const salles = new Map(context.services.rooms.list().map((salle) => [salle.id, salle]))
      // Le hub fait foi sur le nom d'une salle — il se renomme depuis la
      // console — mais un track jamais appairé n'y figure pas encore : le
      // programme donne alors le nom écrit sur la porte, plutôt qu'un slug.
      const nomsDuProgramme = new Map(program.rooms.map((salle) => [salle.id, salle.name]))
      /**
       * Projet OpenFeedback de l'événement.
       *
       * Réglage du hub : le projet est une propriété de l'événement, pas d'une
       * salle. Une salle peut encore le surcharger — c'est devant la machine
       * qu'on découvre qu'elle doit pointer ailleurs — mais un créneau sans
       * salle (une plénière que l'export ne rattache à aucun track) garde son
       * lien, ce que l'ancien repli « la première salle qui en a un » ne
       * garantissait pas.
       */
      const projetDeLEvenement = context.services.settings.get().openFeedbackProjectId

      return {
        contentHash: snapshot.contentHash,
        timezone: program.timezone,
        serverTime: nowIso(context),
        rooms: program.rooms.map(({ id, name }) => ({ id, name })),
        sessions: program.sessions.map((session) => {
          const salle = session.roomId == null ? null : (salles.get(session.roomId) ?? null)
          return {
            id: session.id,
            title: session.title,
            speakers: session.speakers.map((personne) => personne.name),
            startsAt: session.startsAt,
            endsAt: session.endsAt,
            roomId: session.roomId,
            roomName:
              session.roomId == null
                ? null
                : (salle?.name ?? nomsDuProgramme.get(session.roomId) ?? session.roomId),
            kind: session.kind,
            // Pas de lien sur une pause : personne ne note un déjeuner, et un
            // QR mort scanné par le public coûte plus cher qu'une case vide.
            feedbackUrl:
              session.kind === 'break'
                ? null
                : openFeedbackUrl(
                    session,
                    salle?.openFeedbackProjectId ?? projetDeLEvenement,
                    program.timezone,
                  ),
          }
        }),
      }
    }),
  },

  rooms: {
    /** Publique : une machine non appairée doit pouvoir proposer un choix. */
    public: os.rooms.public.handler(({ context }) =>
      context.services.rooms.list().map((room) => ({ id: room.id, name: room.name })),
    ),

    list: os.rooms.list.use(operatorOnly).handler(({ context }) => context.services.rooms.list()),

    /**
     * Publique, comme `rooms.public` : le mur est ouvert à qui scanne le QR,
     * et ces titres sont déjà projetés sur l'écran de la salle.
     */
    current: os.rooms.current.handler(({ input, context }) => {
      const snapshot = context.services.programs.active()
      if (snapshot == null) return { current: null, next: null }

      const at = context.services.clock.now()
      const apercu = (session: Session | null) =>
        session == null
          ? null
          : {
              id: session.id,
              title: session.title,
              speakers: session.speakers.map((personne) => personne.name),
              startsAt: session.startsAt,
              endsAt: session.endsAt,
            }

      return {
        current: apercu(currentSession(snapshot.program, input.roomId, at)),
        next: apercu(nextSession(snapshot.program, input.roomId, at)),
      }
    }),

    /**
     * Réglage d'une salle par elle-même — voir le contrat pour ce qu'elle a le
     * droit de toucher. La cible n'est pas dans l'entrée mais dans le contexte :
     * il n'existe pas de forme de cet appel qui configure une autre salle.
     */
    configure: os.rooms.configure.use(roomOnly).handler(({ input, context }) => {
      const salle = context.services.rooms.get(context.roomId)
      if (salle == null) throw new ORPCError('NOT_FOUND', { message: 'Salle introuvable' })

      const relais = input.relaySourceRoomId
      if (relais != null) {
        if (relais === context.roomId) {
          throw new ORPCError('BAD_REQUEST', {
            message: "Une salle ne peut pas relayer sa propre scène",
          })
        }
        if (context.services.rooms.get(relais) == null) {
          throw new ORPCError('BAD_REQUEST', { message: 'Salle relayée inconnue du hub' })
        }
      }

      // Fusion de surface : la régie envoie `obs` et `sceneRoles` entiers. Ce
      // qui n'est pas dans le correctif — identité, clé de diffusion — reste
      // tel quel, et c'est ce qui rend l'écriture sûre depuis une salle.
      const suivant = {
        ...salle,
        ...input,
        // Seule exception à la fusion de surface : un mot de passe OBS absent
        // du correctif vaut « inchangé », pas « effacé ». La régie ne l'a pas
        // en clair, elle ne peut donc pas le renvoyer pour le conserver.
        obs: input.obs == null ? salle.obs : {
          A: { url: input.obs.A.url, password: input.obs.A.password === undefined ? salle.obs.A.password : input.obs.A.password },
          B: { url: input.obs.B.url, password: input.obs.B.password === undefined ? salle.obs.B.password : input.obs.B.password },
        },
      }
      context.services.rooms.upsert(suivant)
      return suivant
    }),
    /** Lecture seule : la régie affiche l'état des autres salles. */
    statuses: os.rooms.statuses.use(roomOrOperator).handler(({ context }) =>
      // Enrichi hors du service : c'est ici qu'on a le programme et l'horloge
      // sous la main, et la veille qui pousse les notifications lit la même
      // fonction — deux implémentations finiraient par diverger.
      statutsDesSalles(context.services, context.services.clock.now()),
    ),

    /**
     * Resynchronisation complète, demandée depuis la console.
     *
     * Une commande, pas un appel direct : la console ne parle pas aux salles,
     * elle passe par le flux descendant — c'est ce qui fait qu'une salle
     * momentanément coupée rattrape la demande à sa reconnexion au lieu de la
     * perdre.
     *
     * Sans TTL, pour la même raison : une demande de remise d'aplomb ne périme
     * pas comme un « pause déjeuner ». La déduplication par `seq` empêche
     * qu'elle s'applique deux fois au rattrapage.
     */
    resync: os.rooms.resync.use(operatorOnly).handler(({ input, context }) => {
      if (input.roomId != null && context.services.rooms.get(input.roomId) == null) {
        throw new ORPCError('NOT_FOUND', { message: `Salle inconnue : ${input.roomId}` })
      }
      context.services.commands.publish(
        input.roomId,
        { type: 'room.resync', requestedBy: context.operator.email },
        null,
      )
      return {
        ok: true,
        rooms: input.roomId != null ? 1 : context.services.rooms.list().length,
      }
    }),

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
      const reglages = context.services.settings.get()
      return {
        protocolVersion: PROTOCOL_VERSION,
        contentHash: snapshot.contentHash,
        program: unchanged ? null : snapshot.program,
        // Le projet OpenFeedback de l'événement est descendu **résolu** : la
        // salle dessine ses QR hors ligne et n'a pas à connaître la règle de
        // priorité. Ce qu'elle a réglé pour elle-même gagne, comme dans la
        // console.
        room: { ...room, openFeedbackProjectId: room.openFeedbackProjectId ?? reglages.openFeedbackProjectId },
        overrides: context.services.rooms.overrides(),
        serverTime: nowIso(context),
        simulatedClock: context.services.clock.simulated,
        mode: context.services.mode,
        // Descendus avec le reste : la boucle d'attente doit se dérouler
        // entière sans toucher au réseau une fois la salle synchronisée.
        socialLinks: reglages.socialLinks,
        // Même raison, et c'est ce qui rend les écrans renommables : la salle
        // titre ses fenêtres avec le nom que le hub a tranché, pas avec une
        // constante compilée dans le binaire installé sur la machine.
        event: context.services.identity.get(),
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

  /**
   * Bandeau des scènes live.
   *
   * Réservé aux opérateurs : ce qui part là passe dans le direct et dans la
   * VOD de toutes les salles visées.
   */
  overlay: {
    show: os.overlay.show.use(operatorOnly).handler(({ input, context }) => {
      context.services.commands.publish(
        input.roomId,
        { type: 'overlay.set', message: input.message },
        input.ttlSeconds,
      )
      return { ok: true }
    }),

    hide: os.overlay.hide.use(operatorOnly).handler(({ input, context }) => {
      context.services.commands.publish(input.roomId, { type: 'overlay.set', message: null }, null)
      return { ok: true }
    }),

    history: os.overlay.history.use(operatorOnly).handler(({ input, context }) => {
      const passes = context.services.commands.bandeauxPasses(input.roomId, input.limit)
      // Le plus récent dit ce qui est à l'antenne : un retrait n'est pas de
      // l'historique, mais il éteint le bandeau qu'il a retiré.
      const affiche = passes.find((entree) => entree.payload.message != null)
      const retireDepuis = passes.findIndex((entree) => entree.payload.message == null)
      const enCours = retireDepuis === 0 ? null : affiche

      return passes
        .filter((entree) => entree.payload.message != null)
        .slice(0, input.limit)
        .map((entree) => ({
          seq: entree.seq,
          roomId: entree.roomId,
          message: entree.payload.message as { text: string; level: 'info' | 'warning' | 'urgent' },
          issuedAt: entree.issuedAt,
          visible: enCours != null && entree.seq === enCours.seq,
        }))
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
      // Le mode fait foi : déplacer l'heure d'un hub de production fausserait
      // les timecodes des enregistrements et les clôtures automatiques.
      controllable: context.services.mode === 'dev',
    })),

    set: os.clock.set.use(operatorOnly).handler(({ input, context }) => {
      if (context.services.mode !== 'dev') {
        throw new ORPCError('FORBIDDEN', {
          message:
            "Réglage de l'heure fermé : ce hub tourne en production. Il s'ouvre " +
            "avec MODE=dev, jamais pendant l'événement — changer l'heure " +
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
  event: {
    identity: os.event.identity.use(operatorOnly).handler(({ context }) => ({
      resolved: context.services.identity.get(),
      derived: context.services.identity.derived(),
    })),
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
      try {
        await context.auth.api.deviceApprove({
          body: { userCode: input.userCode },
          headers: context.headers,
        })
      } catch (cause) {
        /**
         * Un code appartient au premier opérateur qui l'a consulté.
         *
         * Better Auth le rattache dès la vérification — celle que fait la
         * console en ouvrant le lien de la machine. Un second opérateur qui
         * approuve depuis son propre poste se voit refuser, et le message
         * anglais du plugin n'aide personne à comprendre pourquoi.
         */
        if ((cause as { body?: { error?: string } }).body?.error === 'access_denied') {
          throw new ORPCError('FORBIDDEN', {
            message:
              "Ce code a été ouvert par un autre opérateur : c'est à lui d'approuver, " +
              "ou faites relancer l'appairage depuis la régie pour obtenir un nouveau code",
          })
        }
        throw cause
      }

      context.services.devices.bind({
        clientId: input.clientId,
        roomId: input.roomId,
        label: input.label,
        approvedByUserId: context.operator.id,
      })
      return { ok: true }
    }),

    deny: os.devices.deny.use(operatorOnly).handler(async ({ input, context }) => {
      const verification = await context.auth.api.deviceVerify({
        query: { user_code: input.userCode },
        headers: context.headers,
      })
      await context.auth.api.deviceDeny({
        body: { userCode: input.userCode },
        headers: context.headers,
      })
      /**
       * La demande part avec le refus.
       *
       * Sans ça, la machine refusée restait dans la file jusqu'à ce que
       * quelqu'un l'appaire : refuser n'avait aucun effet visible, et on
       * refusait deux fois.
       */
      if (verification.client_id != null) context.services.devices.forget(verification.client_id)
      return { ok: true }
    }),

    /**
     * Attention : consulter un code le **rattache** à l'opérateur qui regarde.
     *
     * C'est le geste que Better Auth attend d'une page de vérification, et
     * celui que fait déjà l'approbation. La conséquence est qu'un second
     * opérateur ne pourra plus approuver ce code-là — `approve` le dit en
     * clair plutôt que de laisser passer le refus anglais du plugin.
     */
    lookup: os.devices.lookup.use(operatorOnly).handler(async ({ input, context }) => {
      let verification: Awaited<ReturnType<typeof context.auth.api.deviceVerify>>
      try {
        verification = await context.auth.api.deviceVerify({
          query: { user_code: input.userCode },
          headers: context.headers,
        })
      } catch (cause) {
        const reason = raisonDuCode(cause)
        // Une panne authentique doit rester une panne : seuls les deux refus
        // que la console sait expliquer deviennent une réponse.
        if (reason == null) throw cause
        return { status: null, reason, clientId: null, requestedRoomId: null, requestedRoomName: null }
      }

      const scope = verification.scope ?? ''
      const demandee = scope.startsWith('room:') ? scope.slice('room:'.length) : null
      const salle = demandee == null ? null : context.services.rooms.get(demandee)
      return {
        status: verification.status as 'pending' | 'approved' | 'denied',
        reason: null,
        clientId: verification.client_id ?? null,
        requestedRoomId: demandee,
        // Distinct de `requestedRoomId` : une salle demandée qui n'existe pas
        // sur ce hub se voit, au lieu de disparaître silencieusement.
        requestedRoomName: salle?.name ?? null,
      }
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

    /**
     * Publique, comme le dépôt : ces messages sont déjà projetés en salle.
     *
     * Lue depuis l'instantané mémoire du service, jamais en SQL — c'est la
     * seule charge non bornée de la journée.
     */
    recent: os.wall.recent.handler(({ input, context }) =>
      context.services.wall.approved(null).slice(-input.limit).reverse(),
    ),

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

  push: {
    /** Ouvert à tout opérateur : la clé publique n'est pas un secret. */
    publicKey: os.push.publicKey
      .use(operatorOnly)
      .handler(({ context }) => ({ publicKey: context.services.push.publicKey() })),

    subscribe: os.push.subscribe.use(operatorOnly).handler(({ input, context }) => {
      context.services.push.subscribe({
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userId: context.operator.id,
        label: input.label,
        levels: input.levels,
      })
      return { ok: true }
    }),

    unsubscribe: os.push.unsubscribe.use(operatorOnly).handler(({ input, context }) => {
      context.services.push.unsubscribe(input.endpoint)
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

/**
 * Traduit un refus de Better Auth en raison affichable.
 *
 * Le plugin device rend `invalid_request` pour un code qu'il ne connaît pas et
 * `expired_token` pour un code périmé, dans le corps de l'erreur. Les deux
 * n'appellent pas le même geste — recopier le code, ou en demander un nouveau
 * depuis la régie —, et rien d'autre ne permet de les distinguer.
 *
 * @returns `null` pour toute autre erreur : elle doit remonter telle quelle.
 */
function raisonDuCode(cause: unknown): 'inconnu' | 'expire' | null {
  const erreur = (cause as { body?: { error?: string } }).body?.error
  if (erreur === 'expired_token') return 'expire'
  if (erreur === 'invalid_request') return 'inconnu'
  return null
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
