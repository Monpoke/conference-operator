import { implement, withEventMeta } from '@orpc/server'
import { ORPCError } from '@orpc/server'
import {
  POLITIQUE_VOD_PAR_DEFAUT,
  PROTOCOL_VERSION,
  REGIE_SESSION_HEADER,
  contract,
  isCommandExpired,
  type CaptationVue,
  type Command,
} from '@cloudnord/contract'
import { roomBreak } from '@cloudnord/room-state'
import {
  currentSession,
  nextSession,
  FUSEAU_PAR_DEFAUT,
  openFeedbackUrl,
  type Session,
} from '@cloudnord/program'
import type { CaptationBrute } from './services/ingest.js'
import { controlerOpenFeedback } from './services/openfeedback.js'
import {
  commandeDeRegie,
  sallesDeRegie,
  SalleInconnue,
  VerrouTenu,
  vueDeRegie,
} from './services/regie.js'
import { TransitionRefusee } from './services/sessions.js'
import { StockageIncomplet, type VodService } from './services/vod.js'
import { ErreurS3 } from './services/s3.js'
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
        //
        // L'empreinte annoncée est celle du programme **servi**, relue après
        // import : des décisions du jour peuvent survivre au réimport, et
        // annoncer celle du snapshot désignerait une version que personne ne
        // reçoit.
        context.services.commands.publish(
          null,
          {
            type: 'program.invalidate',
            contentHash: context.services.programs.active()?.contentHash ?? snapshot.contentHash,
          },
          null,
        )
        return snapshot
      }),
    snapshots: os.program.snapshots
      .use(operatorOnly)
      .handler(({ context }) => context.services.programs.list()),
    activate: os.program.activate.use(operatorOnly).handler(({ input, context }) => {
      context.services.programs.activate(input.contentHash)
      // Relue après bascule, et pour la même raison qu'à l'import : c'est
      // l'empreinte du programme servi que les salles vont comparer à la leur.
      context.services.commands.publish(
        null,
        {
          type: 'program.invalidate',
          contentHash: context.services.programs.active()?.contentHash ?? input.contentHash,
        },
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
    /**
     * Le créneau commun du moment, vu de l'événement et non d'une salle.
     *
     * Calculé salle par salle puis regroupé : c'est la seule façon honnête de
     * dire « trois salles ». Un créneau commun n'est pas une entité du
     * programme — c'est une pause que plusieurs salles tiennent au même moment,
     * les unes parce qu'elle y est au programme, les autres parce qu'elles n'ont
     * rien de prévu et en héritent.
     *
     * Départage par le nombre de salles : sur un événement où deux pauses se
     * chevauchent, celle qui concerne le plus de monde est celle qu'on affiche.
     */
    globalBreak: os.program.globalBreak.use(operatorOnly).handler(({ context }) => {
      const snapshot = context.services.programs.active()
      const at = context.services.clock.now()
      if (snapshot == null) return null

      const groupes = new Map<
        string,
        { state: 'en-cours' | 'a-venir'; title: string; startsAt: string; endsAt: string | null; startsAtMs: number; rooms: number }
      >()
      for (const salle of snapshot.program.rooms) {
        const pause = roomBreak(snapshot.program, salle.id, at)
        if (pause == null) continue
        const cle = `${pause.session.startsAtMs}-${pause.endsAtMs ?? ''}-${pause.session.title}`
        const connu = groupes.get(cle)
        if (connu != null) {
          connu.rooms += 1
          // Une salle déjà en pause l'emporte sur une salle qui l'anticipe :
          // le créneau a commencé quelque part, il ne s'annonce plus.
          if (pause.state === 'en-cours') connu.state = 'en-cours'
          continue
        }
        groupes.set(cle, {
          state: pause.state,
          title: pause.session.title,
          startsAt: pause.session.startsAt,
          endsAt: pause.endsAtMs == null ? null : new Date(pause.endsAtMs).toISOString(),
          startsAtMs: pause.session.startsAtMs,
          rooms: 1,
        })
      }

      const retenu = [...groupes.values()].sort(
        (a, b) => b.rooms - a.rooms || a.startsAtMs - b.startsAtMs,
      )[0]
      if (retenu == null) return null

      const { startsAtMs: _ignore, ...reste } = retenu
      return { ...reste, serverTime: nowIso(context) }
    }),

    /**
     * Confronte les identifiants du programme à ce qu'OpenFeedback connaît.
     *
     * Les pauses en sont exclues : elles n'ont pas de page de retours, et les
     * compter comme manquantes noierait les vraies anomalies. Les pauses
     * héritées d'une autre salle aussi — elles n'existent que comme projection.
     *
     * L'échec réseau est traduit, comme pour le stockage : « fetch failed » ne
     * dit rien à qui lit la console, et un contrôle qui échoue sans dire
     * pourquoi ne se relance pas.
     */
    controleOpenFeedback: os.program.controleOpenFeedback
      .use(operatorOnly)
      .handler(async ({ context }) => {
        const projet = renseigne(context.services.settings.get().openFeedbackProjectId)
        if (projet == null) {
          throw new ORPCError('BAD_REQUEST', {
            message:
              'Aucun projet OpenFeedback réglé : il n\'y a rien à contrôler tant que ' +
              'le champ des réglages est vide.',
          })
        }
        const snapshot = context.services.programs.active()
        if (snapshot == null) {
          throw new ORPCError('NOT_FOUND', { message: 'Aucun programme actif sur ce hub' })
        }

        const creneaux = snapshot.program.sessions
          .filter((session) => session.kind !== 'break' && session.sharedFrom == null)
          .map((session) => ({
            id: session.id,
            title: session.title,
            feedbackId: session.feedbackId ?? session.id,
          }))

        try {
          return await controlerOpenFeedback(projet, creneaux)
        } catch (cause) {
          throw new ORPCError('BAD_GATEWAY', {
            message: `OpenFeedback est injoignable : ${causeLisible(cause)}`,
          })
        }
      }),

    planning: os.program.planning.use(operatorOnly).handler(({ context }) => {
      const snapshot = context.services.programs.active()
      // Pas d'erreur : un hub tout juste installé n'a pas encore de programme,
      // et la console doit pouvoir le dire plutôt que de tomber en panne.
      if (snapshot == null) {
        return {
          contentHash: null,
          timezone: FUSEAU_PAR_DEFAUT,
          serverTime: nowIso(context),
          // Le réglage se lit quand même : sans programme il n'y a aucun lien à
          // fabriquer, mais la console peut déjà dire s'il en manque un.
          openFeedbackProjectId: renseigne(
            context.services.settings.get().openFeedbackProjectId,
          ),
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
       * Projet OpenFeedback de l'événement. Un seul, et il vient du hub.
       *
       * Plus de surcharge par salle : le champ a existé dans le ⚙ de la régie,
       * et il a suffi qu'un opérateur le remplisse sur une machine pour que
       * cette salle-là ait des liens et pas les autres. Le projet est une
       * propriété de l'événement — un créneau sans salle, plénière que l'export
       * ne rattache à aucun track, a autant droit à son lien qu'un autre.
       */
      const projetDeLEvenement = renseigne(
        context.services.settings.get().openFeedbackProjectId,
      )

      /**
       * Les décisions **appliquées**, pour que la console distingue un genre
       * décidé d'un genre importé : c'est le premier qu'elle propose de
       * retirer, et c'est de là qu'elle déduit ce que dit l'export.
       */
      const surcharges = snapshot.overrides

      /**
       * Le cycle de vie, joint ici plutôt que recroisé par la console.
       *
       * `states(null)` : toutes les salles à la fois, puisque c'est la vue
       * centralisée de l'événement. Le filtre d'applicabilité s'applique comme
       * ailleurs — une décision datée d'après l'instant du hub, ce qui n'arrive
       * qu'en horloge simulée, ne doit pas apparaître ici non plus.
       */
      const vecu = new Map(
        context.services.sessions.states(null).map((etat) => [etat.sessionId, etat]),
      )

      return {
        contentHash: snapshot.contentHash,
        timezone: program.timezone,
        serverTime: nowIso(context),
        openFeedbackProjectId: projetDeLEvenement,
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
                : openFeedbackUrl(session, projetDeLEvenement, program.timezone),
            // Résolu, comme `kind` : l'export sauf correction. Le programme
            // servi porte déjà la correction, il n'y a rien à recroiser ici.
            feedbackId: session.feedbackId ?? session.id,
            feedbackIdOverride: session.feedbackId,
            overriddenAs: surcharges[session.id] ?? null,
            sharedFrom: session.sharedFrom,
            /**
             * Une pause héritée porte un identifiant dérivé, que le cycle de
             * vie ne connaît pas : c'est le créneau d'origine qui est piloté.
             * Chercher sous l'identifiant de la projection ne rendrait jamais
             * rien, et le faire sous celui de l'original afficherait la même
             * décision sur deux lignes.
             */
            startedAt: vecu.get(session.id)?.startedAt ?? null,
            endedAt: vecu.get(session.id)?.endedAt ?? null,
            decidedBy: vecu.get(session.id)?.decidedBy ?? null,
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
        // Le projet OpenFeedback descend **écrasé**, pas complété : quoi qu'une
        // salle ait en cache ou en base, c'est le réglage du hub qui fait foi.
        // La salle dessine ses QR hors ligne, donc la valeur doit voyager ; mais
        // elle n'a rien à décider, et ne peut plus rien contredire.
        room: {
          ...room,
          openFeedbackProjectId: renseigne(reglages.openFeedbackProjectId),
        },
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
        /**
         * Rapatriement des rushes : y a-t-il une destination, et sous quelles
         * règles.
         *
         * Descendu au sync et mis en cache comme le reste : le régulateur de la
         * salle tranche plusieurs fois par minute, et il ne doit jamais dépendre
         * d'un appel réseau — surtout pas au moment précis où le réseau est ce
         * qu'on cherche à ménager. `null` dit « nulle part où envoyer », et une
         * salle qui reçoit `null` cesse d'elle-même : c'est ainsi qu'on éteint
         * la fonctionnalité en cours de journée depuis la console.
         */
        vod:
          context.services.vod == null || !context.services.vod.pret()
            ? null
            : context.services.vod.sync(),
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
      const etat = surTransition(() =>
        context.services.sessions.start(session.id, roomId, auteurDe(context)),
      )
      diffuserEtat(context, etat)
      return etat
    }),

    end: os.sessions.end.use(roomOrOperator).handler(({ input, context }) => {
      const { session, roomId } = resolveSession(context, input.sessionId)
      exigerMemeSalle(context, roomId)
      const etat = surTransition(() =>
        context.services.sessions.end(session.id, roomId, auteurDe(context)),
      )
      diffuserEtat(context, etat)
      return etat
    }),

    /**
     * Surcharge un créneau du programme.
     *
     * Le geste n'existe que parce que l'export amont ne dit pas tout : un
     * accueil, un déjeuner, une plénière y sont des créneaux comme les autres,
     * rattachés à une salle, avec un titre. La salle les titrait donc à
     * l'antenne et la régie proposait de les « commencer ».
     *
     * Décidé ici et pas en salle : c'est le programme de l'événement qu'on
     * corrige, et il doit se lire pareil partout. La diffusion qui suit fait
     * redescendre le programme corrigé — l'empreinte a changé, les salles ne
     * resteront donc pas sur leur cache.
     */
    override: os.sessions.override.use(operatorOnly).handler(({ input, context }) => {
      const snapshot = context.services.programs.active()
      if (snapshot == null) {
        throw new ORPCError('NOT_FOUND', { message: 'Aucun programme actif sur ce hub' })
      }
      const creneau = snapshot.program.sessions.find((session) => session.id === input.sessionId)
      if (creneau == null) {
        throw new ORPCError('NOT_FOUND', {
          message: `Créneau inconnu du programme actif : ${input.sessionId}`,
        })
      }
      /**
       * Une pause héritée d'une autre salle ne s'édite pas.
       *
       * Elle n'existe pas dans l'export : elle est la projection d'un créneau
       * qui, lui, s'édite. Accepter une décision dessus l'enregistrerait sur un
       * identifiant dérivé, que le prochain calcul ne retrouverait pas — une
       * décision qui n'aurait aucun effet et qu'on ne saurait pas retirer.
       */
      if (creneau.sharedFrom != null) {
        throw new ORPCError('BAD_REQUEST', {
          message:
            'Ce créneau est une pause héritée d\'une autre salle : la décision se prend ' +
            'sur le créneau d\'origine, et la projection suit.',
        })
      }

      context.services.rooms.setOverride(input.sessionId, input.action)
      // Relu après écriture : c'est l'empreinte du programme tel qu'il est
      // désormais servi, et c'est elle qu'on annonce aux salles.
      const contentHash = context.services.programs.active()?.contentHash ?? snapshot.contentHash
      context.services.commands.publish(
        null,
        { type: 'program.invalidate', contentHash },
        null,
      )
      return { ok: true, contentHash }
    }),

    /**
     * Corrige l'identifiant OpenFeedback d'un créneau.
     *
     * Rend l'adresse qui en découle : c'est le seul moyen de vérifier la
     * correction, et l'ouvrir d'un clic vaut mieux que la recomposer de tête.
     *
     * Les salles sont prévenues comme pour une décision de genre — elles
     * dessinent leurs QR hors ligne, et un QR resté sur l'ancien identifiant
     * est précisément l'accident que cette procédure existe pour éviter.
     */
    feedbackId: os.sessions.feedbackId.use(operatorOnly).handler(({ input, context }) => {
      const snapshot = context.services.programs.active()
      if (snapshot == null) {
        throw new ORPCError('NOT_FOUND', { message: 'Aucun programme actif sur ce hub' })
      }
      const creneau = snapshot.program.sessions.find((session) => session.id === input.sessionId)
      if (creneau == null) {
        throw new ORPCError('NOT_FOUND', {
          message: `Créneau inconnu du programme actif : ${input.sessionId}`,
        })
      }
      // Une pause n'a pas de page de retours, et une pause héritée n'a même pas
      // d'existence propre : corriger son identifiant n'aurait aucun effet
      // visible, et laisserait une ligne que rien ne viendrait relire.
      if (creneau.kind === 'break') {
        throw new ORPCError('BAD_REQUEST', {
          message: 'Une pause n\'a pas de page OpenFeedback : rien à corriger ici.',
        })
      }

      context.services.rooms.setFeedbackId(input.sessionId, input.feedbackId)

      // Relu après écriture : le programme servi porte désormais la correction,
      // et c'est de lui que l'adresse se déduit — la recomposer ici ferait un
      // second endroit où la règle vit, donc un endroit où elle peut diverger.
      const apres = context.services.programs.active()
      const corrige = apres?.program.sessions.find((session) => session.id === input.sessionId)
      const contentHash = apres?.contentHash ?? snapshot.contentHash
      context.services.commands.publish(null, { type: 'program.invalidate', contentHash }, null)

      return {
        ok: true,
        feedbackId: corrige?.feedbackId ?? creneau.id,
        feedbackUrl:
          corrige == null
            ? null
            : openFeedbackUrl(
                corrige,
                renseigne(context.services.settings.get().openFeedbackProjectId),
                snapshot.program.timezone,
              ),
      }
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
      const salles = new Map(context.services.rooms.list().map((salle) => [salle.id, salle.name] as const))
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

  /**
   * Rapatriement des rushes vers le stockage du hub.
   *
   * Les cinq procédures de salle sont bornées par `roomOnly` : le `roomId` vient
   * du jeton, jamais de l'entrée. Une salle ne peut donc ni téléverser pour une
   * autre, ni lire le plan d'une autre — et révoquer une machine la coupe du
   * stockage sans toucher au bucket.
   */
  vod: {
    begin: os.vod.begin.use(roomOnly).handler(({ input, context }) =>
      surStockage(context, () => exigerStockage(context).begin({ roomId: context.roomId, ...input })),
    ),

    parts: os.vod.parts.use(roomOnly).handler(({ input, context }) =>
      surStockage(context, () => exigerStockage(context).parts(context.roomId, input.uploadId, input.numeros)),
    ),

    progress: os.vod.progress.use(roomOnly).handler(({ input, context }) =>
      surStockage(context, () => {
        exigerStockage(context).progress({ roomId: context.roomId, ...input })
        return { ok: true }
      }),
    ),

    complete: os.vod.complete.use(roomOnly).handler(({ input, context }) =>
      surStockage(context, async () => ({
        ok: true,
        objectKey: await exigerStockage(context).complete(context.roomId, input.uploadId),
      })),
    ),

    abort: os.vod.abort.use(roomOnly).handler(({ input, context }) =>
      surStockage(context, async () => {
        await exigerStockage(context).abort(context.roomId, input.uploadId, input.raison)
        return { ok: true }
      }),
    ),

    /**
     * Une salle ne voit que ses propres téléversements.
     *
     * La régie s'en sert pour peindre sa modale ; la console, elle, passe sans
     * `roomId` et les voit tous. Laisser une salle en interroger une autre ne
     * servirait à rien et donnerait à un jeton de salle une vue de l'événement
     * entier.
     */
    uploads: os.vod.uploads.use(roomOrOperator).handler(({ input, context }) => {
      const vod = exigerStockage(context)
      const salles = new Map(context.services.rooms.list().map((salle) => [salle.id, salle.name]))
      const cible = context.operator != null ? input.roomId : context.roomId
      return vod.uploads(cible, (id) => salles.get(id) ?? null)
    }),

    /**
     * Le dossier VOD d'une conférence. Admin.
     *
     * **Sans `exigerStockage`, et c'est délibéré.** Les deux moitiés de la
     * réponse ne viennent pas du même endroit : les prises sont reconstituées
     * depuis le journal d'ingestion, que tout hub tient, et seuls les
     * téléversements réclament S3. Refuser la procédure entière faute de
     * stockage priverait un hub sans S3 de la seule réponse qui compte le soir
     * du démontage — « le rush est-il sur la machine ? ».
     */
    conference: os.vod.conference.use(operatorOnly).handler(({ input, context }) => {
      const { session, roomId } = resolveSession(context, input.sessionId)
      const salles = new Map(context.services.rooms.list().map((salle) => [salle.id, salle.name]))
      const vod = context.services.vod

      /*
       * Le créneau vécu, pas le créneau prévu.
       *
       * C'est lui qui borne le rattachement à l'heure : un talk annoncé à 14 h
       * et commencé à 14 h 20 a été enregistré à 14 h 20. Comparer à l'horaire
       * du programme raccrocherait la prise du créneau précédent.
       */
      const etat = context.services.sessions.states(roomId)
        .find((candidat) => candidat.sessionId === input.sessionId)

      const captations =
        roomId == null
          ? []
          : context.services.ingest
              .captations(roomId)
              .map((captation) => rattacher(captation, input.sessionId, etat))
              .filter((captation) => captation != null)

      return {
        sessionId: session.id,
        roomId,
        roomName: roomId == null ? null : (salles.get(roomId) ?? null),
        stockageConfigure: vod != null && vod.pret(),
        captations,
        televersements:
          vod == null ? [] : vod.pourSession(input.sessionId, (id) => salles.get(id) ?? null),
      }
    }),

    /**
     * Éprouve la connexion au stockage. Admin.
     *
     * **Pas de `surStockage` ici, et c'est le point** : le diagnostic est la
     * réponse. Traduire l'échec en 502 ferait perdre l'étape à laquelle on
     * s'est arrêté — joindre, authentifier, signer, nettoyer —, c'est-à-dire
     * exactement ce que ce bouton existe pour dire.
     */
    check: os.vod.check.use(operatorOnly).handler(({ context }) => {
      const vod = context.services.vod
      if (vod == null) {
        return {
          ok: false,
          etapes: [
            {
              nom: 'joindre' as const,
              ok: false,
              detail:
                'Aucun stockage S3 configuré sur ce hub : renseigner S3_ENDPOINT, S3_ACCESS_KEY_ID et S3_SECRET_ACCESS_KEY.',
            },
          ],
        }
      }
      return vod.check()
    }),

    /**
     * Remise à zéro. **Développement seulement, et refusé ici, pas seulement caché.**
     *
     * Même garde que le réglage de l'horloge, et pour une raison plus forte
     * encore : une console qui ne rend pas le bouton ne protège que de
     * l'étourderie, pas d'un appel direct. Celui-ci détruit une journée de
     * captation.
     *
     * La confirmation est dans le contrat (`z.literal('RAZ')`) : elle est donc
     * vérifiée par le hub, et pas seulement par la modale.
     */
    reset: os.vod.reset.use(operatorOnly).handler(({ context }) => {
      if (context.services.mode !== 'dev') {
        throw new ORPCError('FORBIDDEN', {
          message:
            "La remise à zéro n'existe qu'en mode développement. Un hub d'événement ne détruit pas ses captations.",
        })
      }
      return surStockage(context, async () => {
        const efface = await exigerStockage(context).raz()
        // Le hub oublie aussi ce qu'il savait des prises : sans cela, le
        // dossier VOD d'une conférence continue de lister des captations dont
        // on vient d'effacer les fichiers, et la remise à zéro paraît sans
        // effet.
        const prises = context.services.ingest.oublierCaptations()
        const salles = context.services.rooms.list()
        for (const salle of salles) {
          context.services.commands.publish(
            salle.id,
            { type: 'vod.reset', requestedBy: context.operator.email },
            null,
          )
        }
        return { ...efface, salles: salles.length, prises }
      })
    }),

    /**
     * L'état du stockage, y compris quand il n'y en a pas.
     *
     * Seule procédure du groupe qui répond sans stockage configuré : c'est
     * précisément sa raison d'être. La console doit pouvoir dire « non
     * configuré », et nommer les variables absentes — elles ne se devinent pas
     * depuis un navigateur.
     */
    status: os.vod.status.use(operatorOnly).handler(({ context }) => {
      const vod = context.services.vod
      if (vod == null) {
        return {
          configure: false,
          endpoint: null,
          bucket: null,
          prefix: null,
          politique: POLITIQUE_VOD_PAR_DEFAUT,
        }
      }
      return vod.status()
    }),

    /**
     * Demande à une salle de téléverser.
     *
     * Une commande, pas un appel direct — comme `rooms.resync`, et pour la même
     * raison : la console ne parle pas aux salles, et une salle momentanément
     * coupée rattrape la demande à sa reconnexion. Sans TTL : « rapatrie tes
     * rushes » ne périme pas.
     */
    request: os.vod.request.use(operatorOnly).handler(({ input, context }) => {
      exigerStockage(context)
      if (context.services.rooms.get(input.roomId) == null) {
        throw new ORPCError('NOT_FOUND', { message: `Salle inconnue : ${input.roomId}` })
      }
      context.services.commands.publish(
        input.roomId,
        { type: 'vod.upload', file: input.file, requestedBy: context.operator.email },
        null,
      )
      return { ok: true }
    }),
  },

  /**
   * Régie mobile.
   *
   * Une seule surface verrouillée, et c'est ce qui rend le verrou tenable :
   * `sessions.start` reste ouverte à la console, `rooms.resync` aussi, et la
   * machine de salle ne passe pas par le hub pour piloter son OBS. Le verrou
   * n'exclut que les régies mobiles entre elles.
   */
  regie: {
    locks: os.regie.locks
      .use(operatorOnly)
      .handler(({ context }) => sallesDeRegie(context.services, context.services.clock.now())),

    hold: os.regie.hold.use(operatorOnly).handler(({ input, context }) => {
      const avant = context.services.regie.lock(input.roomId)
      const verrou = surVerrou(() =>
        context.services.regie.hold(
          input.roomId,
          context.operator.email,
          sessionDeRegie(context),
          input.force,
        ),
      )
      /*
       * Diffuser seulement sur un **changement** de porteur.
       *
       * Le renouvellement passe par ici quand la page reprend la main après une
       * coupure, et il ne change rien à ce que la salle affiche. Publier à
       * chaque fois remplirait la table des commandes d'une information
       * identique — et ferait clignoter le badge en salle.
       */
      /*
       * Sur le **porteur affiché**, pas sur la session.
       *
       * Reprendre une salle d'un onglet à l'autre du même opérateur ne change
       * rien à ce que la salle affiche : republier ferait clignoter le badge
       * sur une information identique.
       */
      if (avant?.holder !== verrou.holder) diffuserVerrou(context, input.roomId, verrou.holder)
      return verrou
    }),

    release: os.regie.release.use(operatorOnly).handler(({ input, context }) => {
      const rendu = context.services.regie.release(input.roomId, sessionDeRegie(context))
      if (rendu) diffuserVerrou(context, input.roomId, null)
      return { ok: rendu }
    }),

    /**
     * L'état de la salle, et le battement du verrou dans le même appel.
     *
     * Le battement d'abord : une vue rendue à un porteur dont le verrou vient
     * d'expirer entre deux sondages le laisserait dépossédé sans qu'il ait rien
     * fait. Renouveler avant de lire referme cette fenêtre.
     *
     * Un appelant qui ne tient pas la salle ne fait que lire — c'est ce qui
     * permet de regarder une salle tenue par quelqu'un d'autre sans la lui
     * prendre.
     */
    view: os.regie.view.use(operatorOnly).handler(({ input, context }) => {
      const verrou = context.services.regie.lock(input.roomId)
      /*
       * Seul le porteur renouvelle, et « le porteur » est une session.
       *
       * Un second onglet du même opérateur ne fait que lire : le contraire
       * ferait vivre indéfiniment un verrou que la page qui l'a pris a cessé
       * de tenir.
       */
      if (verrou != null && verrou.holderId === context.headers.get(REGIE_SESSION_HEADER)) {
        context.services.regie.hold(input.roomId, verrou.holder, verrou.holderId, false)
      }
      return surSalle(() =>
        vueDeRegie(context.services, input.roomId, context.services.clock.now()),
      )
    }),

    command: os.regie.command.use(operatorOnly).handler(({ input, context }) => {
      exigerVerrou(context, input.roomId)

      const resultat = surTransition(() =>
        surSalle(() =>
          commandeDeRegie(context.services, input.roomId, input.action, context.operator.email),
        ),
      )

      /*
       * Une décision de cycle de vie se diffuse comme celle d'une régie de
       * salle, par le même chemin : les autres salles doivent l'apprendre, et
       * la console la voir sans attendre son tour de sondage. La faire
       * autrement aurait donné deux façons d'annoncer le même fait.
       */
      const action = input.action
      if ('sessionId' in action) {
        const etat = context.services.sessions.get(action.sessionId)
        diffuserEtat(context, {
          sessionId: action.sessionId,
          roomId: input.roomId,
          // `reset` supprime la ligne : l'absence *est* « à venir », ici comme
          // dans la table. Sans ce repli, l'annulation ne s'annoncerait pas.
          status: etat?.status ?? 'scheduled',
          decidedBy: context.operator.email,
        })
      }

      return { ok: true, ...resultat }
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
 * Traduit ce que le stockage refuse en quelque chose de lisible en console.
 *
 * Deux familles, et il faut les distinguer : `StockageIncomplet` dit qu'il
 * manque un réglage **ici** — un bucket, un téléversement qu'on a oublié
 * d'ouvrir —, `ErreurS3` rapporte ce que le stockage a répondu, code compris.
 * Les confondre en « erreur interne » enverrait chercher la panne dans le hub
 * quand elle est dans les droits du bucket, et réciproquement.
 *
 * Le code du stockage est repris tel quel : `SignatureDoesNotMatch`,
 * `NoSuchBucket`, `AccessDenied` sont les seuls mots qu'on puisse mettre dans
 * un moteur de recherche, et les traduire les ferait perdre.
 */
async function surStockage<T>(
  context: { services: HubContext['services'] },
  geste: () => T | Promise<T>,
): Promise<T> {
  try {
    return await geste()
  } catch (erreur) {
    /**
     * Ce qui a déjà été traduit passe intact.
     *
     * `exigerStockage` lève un `NOT_IMPLEMENTED` quand aucun stockage n'est
     * configuré : le réempaqueter en « stockage injoignable » ferait chercher
     * une panne réseau là où il n'y a simplement rien de monté — c'est
     * l'inverse exact du service que ce bloc est censé rendre.
     */
    if (erreur instanceof ORPCError) throw erreur
    if (erreur instanceof StockageIncomplet) {
      throw new ORPCError('BAD_REQUEST', { message: erreur.message })
    }
    if (erreur instanceof ErreurS3) {
      throw new ORPCError('BAD_GATEWAY', {
        message: `Le stockage a refusé (${erreur.code}) : ${erreur.message}`,
      })
    }
    /**
     * Tout le reste, plutôt qu'une erreur interne.
     *
     * Le cas qui a motivé ce bloc : le stockage injoignable. `fetch` lève alors
     * un `TypeError: fetch failed` dont la vraie cause — `ECONNREFUSED`,
     * `ENOTFOUND`, un certificat — est rangée dans `cause`, et oRPC en faisait
     * un « Internal Server Error » que la régie affichait tel quel. On cherchait
     * la panne dans le hub alors qu'il manquait un conteneur.
     *
     * Rien ici n'est jamais la faute du hub : ces procédures ne font qu'appeler
     * un stockage tiers. `BAD_GATEWAY` le dit, et le message nomme **l'adresse
     * qu'on a essayé de joindre** — sans elle, on ne sait même pas si c'est
     * celle qu'on croit.
     */
    throw new ORPCError('BAD_GATEWAY', {
      message: `Stockage injoignable (${context.services.vod?.endpoint() ?? 'adresse inconnue'}) : ${causeLisible(erreur)}`,
    })
  }
}

/**
 * Le vrai motif d'un échec réseau, sous la couche de `fetch`.
 *
 * `fetch failed` ne dit rien : c'est le message qu'undici pose sur *toutes* ses
 * pannes de transport. Le code errno, lui, distingue un service éteint
 * (`ECONNREFUSED`) d'un nom qui ne résout pas (`ENOTFOUND`) et d'un pare-feu
 * qui laisse pendre (`ETIMEDOUT`) — trois pannes qui ne se corrigent pas au
 * même endroit.
 */
function causeLisible(erreur: unknown): string {
  const chaine: string[] = []
  let courant: unknown = erreur
  for (let profondeur = 0; courant != null && profondeur < 4; profondeur += 1) {
    const noeud = courant as { message?: string; code?: string; cause?: unknown }
    const code = typeof noeud.code === 'string' ? noeud.code : null
    if (code != null) chaine.push(code)
    else if (typeof noeud.message === 'string' && noeud.message !== '') chaine.push(noeud.message)
    courant = noeud.cause
  }
  return chaine.length === 0 ? String(erreur) : chaine.join(' — ')
}

/**
 * Le service de téléversement, ou un refus qui dit quoi faire.
 *
 * Un hub sans stockage configuré n'est pas en panne : c'est le cas par défaut,
 * et le dire ainsi évite qu'on cherche une erreur de droits sur un bucket qui
 * n'existe pas. `NOT_IMPLEMENTED` plutôt qu'une erreur serveur, parce que rien
 * n'a échoué — la fonctionnalité n'est simplement pas montée.
 */
function exigerStockage(context: { services: HubContext['services'] }): VodService {
  const vod = context.services.vod
  if (vod == null) {
    throw new ORPCError('NOT_IMPLEMENTED', {
      message:
        "Aucun stockage S3 configuré sur ce hub : renseigner S3_ENDPOINT, S3_ACCESS_KEY_ID et S3_SECRET_ACCESS_KEY.",
    })
  }
  return vod
}

/**
 * Cette prise appartient-elle à cette conférence, et à quel titre.
 *
 * Deux réponses possibles, et elles ne se valent pas. La régie estampille
 * normalement chaque prise du créneau en cours : c'est `session`, ce n'est pas
 * discutable, et rien d'autre n'est nécessaire.
 *
 * Reste le cas qui coûte cher un soir de démontage : un enregistrement lancé à
 * la main, avant le « Commencer » de la régie ou sans lui, ne porte aucun
 * créneau. Le rush existe pourtant, il est même le seul qui existe, et le
 * chercher revient à ouvrir les fichiers un par un. On le raccroche alors par
 * le temps — la prise recouvre le créneau **vécu**, dans la même salle — en
 * disant que le rattachement est déduit : c'est une piste, pas un fait, et la
 * console l'affiche comme telle.
 *
 * Le créneau prévu ne sert jamais d'appui : un talk annoncé à 14 h et démarré à
 * 14 h 20 ferait raccrocher la prise du créneau d'avant.
 */
function rattacher(
  captation: CaptationBrute,
  sessionId: string,
  vecu: { startedAt: string | null; endedAt: string | null } | undefined,
): CaptationVue | null {
  if (captation.sessionId === sessionId) {
    return { ...captation, rattachement: 'session' }
  }
  // Estampillée d'un autre créneau : elle appartient à celui-là, pas à celui-ci.
  if (captation.sessionId != null) return null
  if (vecu?.startedAt == null) return null

  const debutTalk = Date.parse(vecu.startedAt)
  // Talk encore en cours : il court jusqu'à maintenant, donc toute prise
  // ouverte depuis son démarrage le recouvre.
  const finTalk = vecu.endedAt == null ? Number.POSITIVE_INFINITY : Date.parse(vecu.endedAt)
  const debutPrise = Date.parse(captation.startedAt)
  const finPrise =
    captation.endedAt == null ? Number.POSITIVE_INFINITY : Date.parse(captation.endedAt)

  const seRecouvrent = debutPrise < finTalk && debutTalk < finPrise
  return seRecouvrent ? { ...captation, rattachement: 'horaire' } : null
}

/**
 * Une chaîne blanche n'est pas une valeur.
 *
 * Un champ texte laissé vide dans un formulaire arrive ici en `''`, pas en
 * `null`, et `??` le laisse passer : c'est ainsi qu'un projet OpenFeedback
 * « réglé à rien » écrasait silencieusement le repli et rendait des adresses
 * `https://openfeedback.io///…`.
 */
function renseigne(valeur: string | null | undefined): string | null {
  const propre = valeur?.trim() ?? ''
  return propre === '' ? null : propre
}

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
/**
 * Traduit un refus du cycle de vie en réponse que la régie sait afficher.
 *
 * `CONFLICT` et pas `BAD_REQUEST` : la demande était bien formée, c'est l'état
 * de la conférence qui a bougé — le plus souvent parce qu'une autre régie, ou
 * la clôture automatique, est passée entre-temps. Le message vient de la table
 * partagée, donc il dit la même chose que le bouton grisé d'en face.
 */
function surTransition<T>(geste: () => T): T {
  try {
    return geste()
  } catch (erreur) {
    if (erreur instanceof TransitionRefusee) {
      throw new ORPCError('CONFLICT', { message: erreur.message })
    }
    throw erreur
  }
}

/**
 * Traduit une salle inconnue en `NOT_FOUND`.
 *
 * Une adresse `/regie/<id>` se met en favori et se partage : un identifiant qui
 * ne désigne plus rien — salle renommée, programme réimporté — doit le dire,
 * pas rendre une vue vide qu'on lirait comme une salle éteinte.
 */
function surSalle<T>(geste: () => T): T {
  try {
    return geste()
  } catch (erreur) {
    if (erreur instanceof SalleInconnue) {
      throw new ORPCError('NOT_FOUND', { message: erreur.message })
    }
    throw erreur
  }
}

/** Traduit une salle déjà tenue en `CONFLICT`, en nommant le porteur. */
function surVerrou<T>(geste: () => T): T {
  try {
    return geste()
  } catch (erreur) {
    if (erreur instanceof VerrouTenu) {
      throw new ORPCError('CONFLICT', { message: erreur.message })
    }
    throw erreur
  }
}

/**
 * Refuse un geste à qui ne tient pas la salle.
 *
 * Le message nomme le porteur : « refusé » sans dire par qui envoie chercher un
 * défaut là où il n'y a qu'un collègue à l'autre bout du bâtiment. Et il
 * distingue le verrou absent du verrou d'autrui — le premier se répare d'un
 * clic sur « Prendre la salle », le second demande une décision.
 */
function exigerVerrou(context: HubContext, roomId: string): void {
  const verrou = context.services.regie.lock(roomId)
  if (verrou == null) {
    throw new ORPCError('FORBIDDEN', {
      message: "Prenez la salle avant de la piloter : personne ne la tient",
    })
  }
  if (verrou.holderId !== context.headers.get(REGIE_SESSION_HEADER)) {
    throw new ORPCError('FORBIDDEN', {
      message: `${verrou.holder} tient la régie de cette salle`,
    })
  }
}

/**
 * L'onglet qui parle, ou un refus.
 *
 * Exigé plutôt que déduit du compte : retomber sur l'adresse en l'absence de
 * l'en-tête dégraderait l'exclusivité en silence, et c'est le genre de repli
 * qu'on ne découvre que le jour où deux onglets pilotent la même salle.
 */
function sessionDeRegie(context: HubContext): string {
  const session = context.headers.get(REGIE_SESSION_HEADER)
  if (session == null || session === '') {
    throw new ORPCError('BAD_REQUEST', {
      message: `En-tête ${REGIE_SESSION_HEADER} absent : la régie ne s'identifie pas`,
    })
  }
  return session
}

/**
 * Annonce à la salle qui la pilote à distance, ou que personne ne le fait.
 *
 * Durable (`ttl` nul) comme `session.state` : c'est un changement d'état, pas
 * un message d'un instant. Une salle momentanément coupée doit le retrouver à
 * sa reconnexion — sinon son écran de régie affiche un porteur parti depuis une
 * heure, ou n'en affiche aucun alors qu'on la pilote.
 */
function diffuserVerrou(
  context: { services: HubContext['services'] },
  roomId: string,
  holder: string | null,
): void {
  context.services.commands.publish(roomId, { type: 'regie.hold', holder }, null)
}

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
