import { eventIterator, oc } from '@orpc/contract'
import { z } from 'zod'
import { programSchema } from '@cloudnord/program'
import { bandeauSchema, commandSchema } from './commands.js'
import { envelopeSchema, ingestResultSchema } from './events.js'
import {
  isoDateTimeSchema,
  roomIdSchema,
  sessionIdSchema,
  PROTOCOL_VERSION,
} from './primitives.js'
import {
  hubSettingsSchema,
  roomConfigPatchSchema,
  roomConfigSchema,
  roomStatusSchema,
  sessionStateSchema,
  sessionStateViewSchema,
  syncResultSchema,
} from './room-state.js'
import { commentSchema, commentSourceSchema, questionSchema } from './wall.js'

/**
 * Contrat unique du système, monté sur trois transports :
 *  - HTTP/Fastify  → hub-admin, wall-web
 *  - WebSocket     → room-client ↔ hub
 *  - MessagePort   → Electron main ↔ renderers (régie, display, overlay)
 *
 * Une seule définition, aucune duplication : validé par `spikes/orpc-v2`.
 */

/** Ce qu'une surface publique a besoin de savoir d'une conférence. */
const sessionApercuSchema = z.object({
  id: sessionIdSchema,
  title: z.string(),
  speakers: z.array(z.string()),
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema.nullable(),
})

/**
 * Une ligne du planning, telle que la console la relit.
 *
 * Volontairement plus large que `sessionApercuSchema` : la console affiche le
 * programme **entier**, pauses comprises, et pas seulement ce qui court en ce
 * moment dans une salle.
 */
const planningSessionSchema = sessionApercuSchema.extend({
  roomId: roomIdSchema.nullable(),
  /** Le nom de la salle, pas son identifiant : c'est ce qui est écrit sur la porte. */
  roomName: z.string().nullable(),
  /** `break` = créneau sans intervenant : accueil, pause, déjeuner. */
  kind: z.enum(['talk', 'break']),
  /**
   * Lien « notez ce talk » sur OpenFeedback.
   *
   * Résolu par le hub et non par la console : l'adresse se déduit du programme
   * et du projet réglé sur la salle, deux choses que la console n'a pas. `null`
   * sur une pause ou sans projet configuré — un lien mort scanné par le public
   * coûte plus cher qu'une case vide.
   */
  feedbackUrl: z.url().nullable(),
})

export const contract = {
  meta: {
    /** Ping de disponibilité applicative — sert aussi de base à l'offset d'horloge. */
    hello: oc
      .input(z.object({ protocolVersion: z.number().int() }))
      .output(
        z.object({
          protocolVersion: z.literal(PROTOCOL_VERSION),
          serverTime: isoDateTimeSchema,
          /** Heure simulée : à signaler, sinon l'écart avec la réalité déroute. */
          simulatedClock: z.boolean().default(false),
          compatible: z.boolean(),
        }),
      ),
  },

  program: {
    /** Importe l'export amont et crée un snapshot versionné. Admin. */
    import: oc
      .input(z.object({ sourceUrl: z.url() }))
      .output(
        z.object({
          contentHash: z.string(),
          importedAt: isoDateTimeSchema,
          program: programSchema,
        }),
      ),
    /** Historique des snapshots, pour rollback en un clic le jour J. */
    snapshots: oc.output(
      z.array(
        z.object({
          contentHash: z.string(),
          importedAt: isoDateTimeSchema,
          active: z.boolean(),
          sessionCount: z.number().int(),
          issueCount: z.number().int(),
        }),
      ),
    ),
    activate: oc.input(z.object({ contentHash: z.string() })).output(z.object({ ok: z.boolean() })),
    /**
     * Le programme actif, à plat et prêt à afficher. Admin.
     *
     * Le hub détient déjà le programme ; sans cette procédure, la console ne
     * connaît que les conférences **démarrées** et ne peut pas répondre à « et
     * après, il y a quoi ». Renvoyé à plat plutôt que le `programSchema`
     * complet : les biographies, les logos de sponsors et les visuels pèsent
     * l'essentiel des 70 ko d'un snapshot, et rien de tout cela ne s'affiche
     * dans un planning.
     */
    planning: oc.output(
      z.object({
        /** Version affichée : la même que dans la liste des snapshots. `null` si aucun programme. */
        contentHash: z.string().nullable(),
        /** Fuseau de l'événement : les heures se lisent là-bas, pas sur le PC de la console. */
        timezone: z.string(),
        /**
         * Heure du hub au moment de la lecture.
         *
         * C'est elle qui désigne le créneau surligné « maintenant ». Prise ici
         * et non dans le navigateur pour la même raison que `remainingMs` :
         * l'horloge du hub peut être simulée, et c'est elle qui fait foi — un
         * surlignage calculé sur l'heure du poste pointerait un créneau de la
         * semaine dernière pendant qu'on déroule la journée depuis le menu
         * Développement.
         */
        serverTime: isoDateTimeSchema,
        rooms: z.array(z.object({ id: roomIdSchema, name: z.string() })),
        sessions: z.array(planningSessionSchema),
      }),
    ),
  },

  rooms: {
    /**
     * Liste publique des salles : identifiant et nom, rien d'autre.
     *
     * Une machine doit pouvoir proposer un choix **avant** d'être appairée,
     * donc avant d'avoir le moindre jeton. Ces noms sont déjà publics — le mur
     * scanné par les participants les affiche.
     */
    public: oc.output(z.array(z.object({ id: roomIdSchema, name: z.string() }))),
    list: oc.output(z.array(roomConfigSchema)),
    /** `since` = dernier `contentHash` connu ; le snapshot n'est renvoyé que s'il a changé. */
    sync: oc
      .input(z.object({ since: z.string().nullable() }))
      .output(syncResultSchema),
    /**
     * Réglage d'une salle par elle-même.
     *
     * Le hub reste la source de vérité — c'est lui qui repousse la config à
     * chaque `sync`, et une modification gardée en local serait écrasée au
     * suivant. Mais la saisie, elle, a sa place en salle : les adresses des
     * deux OBS et les noms de scènes se constatent devant les machines, pas
     * depuis une console à l'autre bout du bâtiment.
     *
     * Bornée à la salle appelante par `roomOnly` : le contexte porte le
     * `roomId`, il n'est pas dans l'entrée, donc aucune salle ne peut en
     * configurer une autre.
     */
    configure: oc.input(roomConfigPatchSchema).output(roomConfigSchema),
    /**
     * Conférence en cours et suivante d'une salle. **Publique.**
     *
     * Le mur s'en sert pour dire au participant ce qu'il est en train
     * d'écouter : sans ça, « posez votre question » ne dit pas à propos de
     * quoi, et les questions arrivent en régie sans qu'on sache à quel talk
     * les rattacher. Ces titres sont déjà publics — ils sont projetés.
     */
    current: oc
      .input(z.object({ roomId: roomIdSchema }))
      .output(
        z.object({
          current: sessionApercuSchema.nullable(),
          next: sessionApercuSchema.nullable(),
        }),
      ),
    /** Supervision des salles dans l'admin. */
    statuses: oc.output(z.array(roomStatusSchema)),
    /**
     * Flux descendant. Chaque événement est estampillé avec son `seq` via
     * `withEventMeta` : la reprise après coupure passe par `lastEventId`, pas
     * par un paramètre d'entrée.
     */
    commands: oc.output(eventIterator(commandSchema)),
  },

  /**
   * Bandeau des scènes live.
   *
   * Une surface à part, et non un mode de plus sur l'écran de salle : le
   * bandeau se superpose à la vidéo sans rien interrompre, là où un message
   * d'écran remplace tout. Les deux servent à des moments différents.
   */
  overlay: {
    /** Met un bandeau à l'antenne. `roomId` nul = toutes les salles. */
    show: oc
      .input(
        z.object({
          roomId: roomIdSchema.nullable(),
          message: bandeauSchema,
          /** Durée d'affichage. `null` = jusqu'à ce qu'on le retire. */
          ttlSeconds: z.number().int().positive().max(3600).nullable().default(null),
        }),
      )
      .output(z.object({ ok: z.boolean() })),

    /** Retire le bandeau. */
    hide: oc
      .input(z.object({ roomId: roomIdSchema.nullable() }))
      .output(z.object({ ok: z.boolean() })),

    /**
     * Ce qui est déjà passé à l'antenne, du plus récent au plus ancien.
     *
     * Lu dans les commandes émises : elles sont déjà persistées et datées, et
     * en tenir une seconde copie ne pourrait que diverger. Sert à remettre un
     * bandeau sans le retaper — un « on reprend dans 5 minutes » ressort
     * plusieurs fois dans une journée.
     */
    history: oc
      .input(
        z.object({
          roomId: roomIdSchema.nullable().default(null),
          limit: z.number().int().min(1).max(100).default(20),
        }),
      )
      .output(
        z.array(
          z.object({
            seq: z.number().int(),
            roomId: roomIdSchema.nullable(),
            message: bandeauSchema,
            issuedAt: isoDateTimeSchema,
            /** Ce bandeau est-il celui qui est à l'antenne en ce moment ? */
            visible: z.boolean(),
          }),
        ),
      ),
  },

  /**
   * Cycle de vie des conférences.
   *
   * Piloté depuis la régie de la salle **et** depuis la console : un talk peut
   * déborder sans que l'opérateur de salle soit disponible, et l'organisateur
   * doit pouvoir trancher à distance.
   */
  sessions: {
    /** États connus. Sans `roomId`, toutes salles — c'est la vue de la console. */
    states: oc
      .input(z.object({ roomId: roomIdSchema.nullable() }))
      .output(z.array(sessionStateViewSchema)),
    start: oc.input(z.object({ sessionId: sessionIdSchema })).output(sessionStateSchema),
    end: oc.input(z.object({ sessionId: sessionIdSchema })).output(sessionStateSchema),
    /** Annule une décision : le talk redevient « à venir ». */
    reset: oc.input(z.object({ sessionId: sessionIdSchema })).output(z.object({ ok: z.boolean() })),
  },

  /**
   * Échange de messages entre la console et les salles.
   *
   * Deux sens distincts : la console diffuse une commande (immédiate, avec un
   * TTL), une salle remonte par son outbox (durable, survit à une coupure).
   */
  messages: {
    /** Envoie un message. `roomId` nul = toutes les salles. */
    send: oc
      .input(
        z.object({
          roomId: roomIdSchema.nullable(),
          text: z.string().min(1).max(500),
          level: z.enum(['info', 'warning', 'urgent']),
          target: z.enum(['operator', 'audience']),
          /** Durée d'affichage. `null` = jusqu'à remplacement. */
          ttlSeconds: z.number().int().positive().max(3600).nullable(),
        }),
      )
      .output(z.object({ ok: z.boolean() })),

    /** Messages remontés par les salles, du plus récent au plus ancien. */
    fromRooms: oc
      .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
      .output(
        z.array(
          z.object({
            id: z.string(),
            roomId: roomIdSchema,
            roomName: z.string().nullable(),
            text: z.string(),
            level: z.enum(['info', 'warning', 'urgent']),
            occurredAt: isoDateTimeSchema,
            receivedAt: isoDateTimeSchema,
          }),
        ),
      ),
  },

  /**
   * Heure du hub.
   *
   * Outil de développement : déplacer l'heure permet de dérouler une journée
   * d'événement à l'avance. Fermé par défaut côté serveur — le faire pendant
   * l'événement fausserait les timecodes des enregistrements.
   */
  clock: {
    get: oc.output(
      z.object({
        serverTime: isoDateTimeSchema,
        simulated: z.boolean(),
        /** Le hub autorise-t-il le réglage depuis la console ? */
        controllable: z.boolean(),
      }),
    ),
    /** `at` nul revient à l'heure réelle. */
    set: oc
      .input(z.object({ at: isoDateTimeSchema.nullable() }))
      .output(z.object({ serverTime: isoDateTimeSchema, simulated: z.boolean() })),
  },

  /** Réglages modifiables en cours d'événement. */
  settings: {
    get: oc.output(hubSettingsSchema),
    update: oc.input(hubSettingsSchema.partial()).output(hubSettingsSchema),
  },

  ingest: {
    /**
     * Vidange de l'outbox. Idempotent sur `(roomId, envelope.id)` : un rejeu
     * après reconnexion renvoie `duplicates`, jamais une seconde insertion.
     */
    push: oc
      .input(z.object({ batch: z.array(envelopeSchema).min(1).max(500) }))
      .output(ingestResultSchema),
  },

  wall: {
    /**
     * Dépôt public depuis le mobile (QR). Passe par la modération.
     *
     * `roomId` nul — ce qu'envoie le mur public — vaut « toutes les salles » :
     * un message du public s'adresse à l'événement, pas à la pièce où son
     * auteur se trouve. Le champ reste là pour les sources qui, elles, savent
     * de quelle salle elles parlent.
     */
    post: oc
      .input(
        z.object({
          roomId: roomIdSchema.nullable(),
          author: z.string().min(1).max(80),
          text: z.string().min(1).max(500),
        }),
      )
      .output(z.object({ id: z.string(), status: z.literal('pending') })),
    /** Flux des messages approuvés, consommé par les écrans de salle. */
    feed: oc
      .input(z.object({ roomId: roomIdSchema.nullable() }))
      .output(eventIterator(commentSchema)),
    /**
     * Derniers messages déjà à l'écran. **Publique.**
     *
     * Sert au mur sur mobile : sans elle, déposer un message revenait à parler
     * dans le vide — rien ne montrait que d'autres écrivaient, ni que ça
     * finissait réellement projeté. Ces messages sont déjà publics au sens le
     * plus fort du terme : ils sont affichés en grand dans les salles.
     *
     * Servie depuis l'instantané mémoire du hub, comme le flux : le mur est la
     * seule charge non bornée de la journée — quelques centaines de mobiles
     * quand le QR est à l'écran — et elle ne doit pas se traduire en requêtes.
     */
    recent: oc
      .input(z.object({ limit: z.number().int().min(1).max(30).default(12) }))
      .output(z.array(commentSchema)),
    /** File de modération, toutes sources confondues. Admin. */
    pending: oc
      .input(z.object({ source: commentSourceSchema.optional() }))
      .output(z.array(commentSchema)),
    moderate: oc
      .input(z.object({ id: z.string(), decision: z.enum(['approve', 'reject']) }))
      .output(z.object({ ok: z.boolean() })),
  },

  /**
   * Appairage des machines de salle.
   *
   * L'échange de jetons lui-même se fait sur les endpoints Better Auth
   * (`/api/auth/device/*`, RFC 8628) : ces procédures-ci couvrent ce que Better
   * Auth ne sait pas — quelle salle une machine dessert.
   */
  devices: {
    /** Machines ayant demandé un appairage et pas encore traitées. Admin. */
    pending: oc.output(
      z.array(
        z.object({
          clientId: z.string(),
          scope: z.string().nullable(),
          requestedAt: isoDateTimeSchema,
        }),
      ),
    ),
    /**
     * Approuve une machine *et* l'affecte à une salle, en une seule opération.
     * Les deux doivent être atomiques : une machine approuvée mais non affectée
     * détiendrait un jeton valide sans salle, ce qui est un état inutile et
     * déroutant en régie.
     */
    approve: oc
      .input(
        z.object({
          userCode: z.string().min(4),
          clientId: z.string(),
          roomId: roomIdSchema,
          label: z.string().max(80).optional(),
        }),
      )
      .output(z.object({ ok: z.boolean() })),
    deny: oc.input(z.object({ userCode: z.string().min(4) })).output(z.object({ ok: z.boolean() })),
    /**
     * État d'un code d'appairage, sans rien approuver.
     *
     * Sert au lien que la machine affiche : arriver sur la console avec un code
     * mort et une file de demandes ne dit rien de ce qui cloche. Un code
     * inconnu et un code expiré ne se corrigent pas de la même façon — l'un est
     * une faute de frappe ou une base recréée, l'autre demande de relancer
     * l'appairage depuis la régie —, d'où deux raisons distinctes plutôt qu'une
     * erreur.
     */
    lookup: oc.input(z.object({ userCode: z.string().min(4) })).output(
      z.object({
        /** État Better Auth du code, ou `null` s'il n'est plus exploitable. */
        status: z.enum(['pending', 'approved', 'denied']).nullable(),
        /** Renseignée quand `status` est `null` : pourquoi le code ne vaut rien. */
        reason: z.enum(['inconnu', 'expire']).nullable(),
        clientId: z.string().nullable(),
        /** Salle demandée par la machine, telle qu'elle voyage dans le scope. */
        requestedRoomId: roomIdSchema.nullable(),
        /** `null` si la salle demandée n'existe pas (ou plus) sur ce hub. */
        requestedRoomName: z.string().nullable(),
      }),
    ),
    /**
     * Échange la session d'approbation contre un jeton de salle.
     *
     * Appelé par la machine juste après l'appairage, avec la session que lui a
     * value l'approbation. Ce jeton porte les droits d'une salle et rien de
     * plus ; la session Better Auth est ensuite jetée.
     */
    claim: oc.output(
      z.object({
        token: z.string(),
        roomId: roomIdSchema,
      }),
    ),
    /** Machines appairées, pour la supervision et la révocation. */
    list: oc.output(
      z.array(
        z.object({
          clientId: z.string(),
          roomId: roomIdSchema,
          label: z.string().nullable(),
          approvedAt: isoDateTimeSchema,
          lastSeenAt: isoDateTimeSchema.nullable(),
          revokedAt: isoDateTimeSchema.nullable(),
        }),
      ),
    ),
    /** Coupe l'accès d'une machine sans toucher au compte de l'opérateur. */
    revoke: oc.input(z.object({ clientId: z.string() })).output(z.object({ ok: z.boolean() })),
  },

  /**
   * Notifications poussées aux consoles, **fenêtre fermée**.
   *
   * La console se regarde sur un téléphone rangé dans une poche : les
   * notifications de la page s'arrêtent dès que le navigateur s'endort, ce qui
   * est précisément le moment où l'on a besoin d'être prévenu. Le Web Push
   * traverse cet endormissement, au prix d'un abonnement par navigateur et
   * d'une veille côté hub — lui seul peut encore constater qu'une salle est
   * tombée quand plus personne ne regarde.
   */
  push: {
    /**
     * Clé publique VAPID du hub, à passer à `pushManager.subscribe`.
     *
     * `null` quand le push n'est pas disponible : la console ne propose alors
     * que les notifications de page, plutôt qu'un bouton qui échouerait.
     */
    publicKey: oc.output(z.object({ publicKey: z.string().nullable() })),
    /** Enregistre le navigateur. Ré-appelable : le même endpoint écrase. */
    subscribe: oc
      .input(
        z.object({
          endpoint: z.url(),
          keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
          /** Étiquette lisible — « iPhone de la régie » — pour s'y retrouver. */
          label: z.string().max(80).nullable().default(null),
        }),
      )
      .output(z.object({ ok: z.boolean() })),
    unsubscribe: oc.input(z.object({ endpoint: z.url() })).output(z.object({ ok: z.boolean() })),
  },

  questions: {
    post: oc
      .input(
        z.object({
          roomId: roomIdSchema,
          sessionId: sessionIdSchema.nullable(),
          author: z.string().max(80).nullable(),
          text: z.string().min(1).max(300),
        }),
      )
      .output(questionSchema),
    /** `deviceId` limite le vote multiple sans imposer de compte. */
    vote: oc
      .input(z.object({ id: z.string(), deviceId: z.string().min(8) }))
      .output(z.object({ votes: z.number().int() })),
    list: oc
      .input(z.object({ roomId: roomIdSchema, sessionId: sessionIdSchema.nullable() }))
      .output(z.array(questionSchema)),
  },
}

export type Contract = typeof contract
