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
import { eventIdentitySchema } from './event-identity.js'
import {
  hubSettingsSchema,
  niveauxNotifSchema,
  roomConfigPatchSchema,
  roomConfigSchema,
  roomStatusSchema,
  sessionStateSchema,
  sessionStateViewSchema,
  syncResultSchema,
} from './room-state.js'
import { commentSchema, commentSourceSchema, questionSchema } from './wall.js'
import {
  controleStockageSchema,
  genreVodSchema,
  partSigneeSchema,
  planTeleversementSchema,
  politiqueVodSchema,
  televersementVuSchema,
} from './vod.js'

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
  /**
   * Décision prise sur ce créneau depuis la console, ou `null`.
   *
   * Le `kind` ci-dessus est déjà celui que le hub **sert** : un créneau
   * surchargé y arrive corrigé, comme partout ailleurs. Ce champ dit d'où vient
   * ce genre — de l'export, ou d'une décision — ce que la console est seule à
   * avoir besoin de savoir : c'est elle qui l'a prise, c'est chez elle qu'on la
   * retire, et elle en déduit ce que dit l'export (l'inverse, puisqu'une
   * décision sans effet n'est jamais appliquée).
   */
  overriddenAs: z.enum(['talk', 'break']).nullable().default(null),
  /**
   * Créneau dont cette ligne est la projection dans une autre salle, ou `null`.
   *
   * Une salle libre pendant qu'une autre est en pause hérite de cette pause :
   * la ligne existe donc dans le programme servi sans exister dans l'export.
   * Elle ne s'édite pas — c'est l'original qu'on corrige, et la projection
   * suit.
   */
  sharedFrom: z.string().nullable().default(null),
  /**
   * Quand la conférence a **réellement** commencé et fini, ou `null`.
   *
   * Les `startsAt` / `endsAt` ci-dessus sont ceux du programme : ce qui était
   * prévu. Ceux-ci sont ce qui s'est passé — l'instant du « Commencer » et
   * celui du « Terminer », clôture automatique comprise. Les deux se lisent
   * côte à côte, et c'est l'écart qui intéresse : un retard au démarrage, un
   * dépassement, une durée réelle pour le montage.
   *
   * Joints **par le hub**, pas par la console. Le cycle de vie est écrit ici,
   * il vaut pour toutes les salles à la fois, et une console qui recroiserait
   * elle-même deux listes finirait par en afficher une version qui n'est celle
   * de personne. `null` sur un créneau que personne n'a piloté — ce qui est le
   * cas de toutes les pauses, et des conférences encore à venir.
   */
  startedAt: isoDateTimeSchema.nullable().default(null),
  endedAt: isoDateTimeSchema.nullable().default(null),
  /**
   * Qui a décidé, ou `null` si personne n'a rien décidé.
   *
   * `auto` pour la règle horaire, l'adresse de l'opérateur sinon. C'est la
   * seule chose qui répond à « je n'ai pas fait ça » — une conférence marquée
   * terminée sans qu'on s'en souvienne se retrouve dans un journal, ou nulle
   * part.
   */
  decidedBy: z.string().nullable().default(null),
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
    /**
     * Le créneau commun du moment : ce qui concerne tout le monde à la fois.
     *
     * Séparé de la supervision par salle, parce que la question n'est pas la
     * même : les cartes disent où en est chaque salle, celui-ci dit ce que fait
     * l'événement. `null` le reste du temps — l'encart n'a alors rien à dire, et
     * un encart vide se lit comme une panne.
     */
    globalBreak: oc.output(
      z
        .object({
          /** `a-venir` : il commence dans moins d'un quart d'heure. */
          state: z.enum(['en-cours', 'a-venir']),
          title: z.string(),
          startsAt: isoDateTimeSchema,
          /** Reprise : fin effective du break. `null` si rien ne le ferme. */
          endsAt: isoDateTimeSchema.nullable(),
          /** Nombre de salles concernées — toutes, le plus souvent. */
          rooms: z.number().int(),
          /** Heure du hub, base du décompte : le navigateur n'a que la sienne. */
          serverTime: isoDateTimeSchema,
        })
        .nullable(),
    ),

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
     * Demande une resynchronisation complète. `roomId` nul = toutes les salles.
     *
     * Réservée à l'opérateur : c'est un geste de console, pas quelque chose
     * qu'une salle se demande à elle-même — la régie a déjà son bouton.
     *
     * `rooms` compte les salles visées, pour que la console puisse le dire
     * plutôt que d'annoncer un envoi sans destinataire quand il n'y en a aucune.
     */
    resync: oc
      .input(z.object({ roomId: roomIdSchema.nullable() }))
      .output(z.object({ ok: z.boolean(), rooms: z.number().int() })),
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
    /**
     * Surcharge un créneau du programme, sans réimport.
     *
     * `action: null` retire la surcharge : le créneau redevient ce que dit
     * l'export. Réservée à l'opérateur — c'est une décision sur le programme de
     * l'événement, pas sur le déroulé d'une salle.
     *
     * Rend l'empreinte du programme tel qu'il est désormais servi : elle change
     * avec la surcharge, et c'est ce qui fait redescendre le programme dans les
     * salles au lieu de les laisser sur leur cache.
     */
    override: oc
      .input(
        z.object({
          sessionId: sessionIdSchema,
          action: z.enum(['talk', 'break']).nullable(),
        }),
      )
      .output(z.object({ ok: z.boolean(), contentHash: z.string() })),
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

  /**
   * Identité de l'événement, telle que le hub la tranche.
   *
   * Lecture seule : elle s'écrit par `settings.update` (ou pas du tout, quand
   * elle se déduit du programme importé). Deux valeurs plutôt qu'une, parce
   * que la console doit pouvoir dire ce qu'on obtiendrait en relâchant le
   * réglage — sinon personne n'ose vider un champ.
   */
  event: {
    identity: oc.output(
      z.object({
        /** Ce qui s'affiche partout : réglage s'il existe, déduction sinon. */
        resolved: eventIdentitySchema,
        /** Ce que donnerait le programme importé seul, réglages ignorés. */
        derived: eventIdentitySchema,
      }),
    ),
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
          /**
           * Ce que ce navigateur-là veut recevoir.
           *
           * Rangé avec l'abonnement, et non avec l'opérateur : c'est la même
           * personne qui veut l'essentiel sur le téléphone dans sa poche et
           * tout sur la console posée devant elle.
           */
          levels: niveauxNotifSchema.default({ technique: 'essentiel', exploitation: 'essentiel' }),
        }),
      )
      .output(z.object({ ok: z.boolean() })),
    unsubscribe: oc.input(z.object({ endpoint: z.url() })).output(z.object({ ok: z.boolean() })),
  },

  /**
   * Rapatriement des rushes vers le stockage S3 du hub.
   *
   * Le hub détient les clés et ne les donne jamais : il signe des adresses à
   * durée de vie courte, la salle téléverse dessus. Une machine de salle volée
   * ne donne accès à aucun bucket, et révoquer une salle suffit à la couper du
   * stockage — c'est la même raison qui fait qu'une salle a son propre jeton
   * plutôt que celui d'un opérateur.
   *
   * Toutes les procédures de salle sont bornées à la salle appelante par
   * `roomOnly` : le `roomId` vient du jeton, jamais de l'entrée.
   */
  vod: {
    /**
     * Ouvre — ou **reprend** — le téléversement d'un fichier.
     *
     * Idempotente sur `(salle, fichier)` : rappeler ne recommence rien, elle
     * rend le plan déjà ouvert avec la liste des parts arrivées. C'est ce qui
     * rend une machine redémarrée en pleine montée capable de repartir d'où
     * elle en était, au lieu de refaire trois gigaoctets.
     *
     * C'est aussi la **notification de début** : le hub n'apprend pas
     * autrement qu'une salle s'est mise à monter quelque chose.
     */
    begin: oc
      .input(
        z.object({
          /** Chemin relatif à la racine des enregistrements, tel que la salle le nomme. */
          file: z.string().min(1).max(400),
          sizeBytes: z.number().int().nonnegative(),
          kind: genreVodSchema,
          sessionId: sessionIdSchema.nullable().default(null),
        }),
      )
      .output(planTeleversementSchema),

    /**
     * Signe les adresses d'un lot de parts.
     *
     * Par petits lots et à la demande, jamais toutes d'avance : une adresse
     * signée périme, et en presigner cinq cents pour un rush de deux heures,
     * c'est en périmer quatre cent quatre-vingts avant qu'on y arrive.
     */
    parts: oc
      .input(
        z.object({
          uploadId: z.string(),
          numeros: z.array(z.number().int().positive()).min(1).max(20),
        }),
      )
      .output(z.array(partSigneeSchema)),

    /**
     * Une part est arrivée.
     *
     * L'`etag` n'est pas de la comptabilité : S3 le réclame, part par part, au
     * moment de clore le téléversement. Sans lui l'objet ne se recompose pas.
     * La durée sert au régulateur de la salle, qui décide de continuer ou de
     * lever le pied sur ce qu'il constate, pas sur ce qu'on lui promet.
     */
    progress: oc
      .input(
        z.object({
          uploadId: z.string(),
          numero: z.number().int().positive(),
          etag: z.string().min(1),
          octets: z.number().int().positive(),
          dureeMs: z.number().int().nonnegative(),
        }),
      )
      .output(z.object({ ok: z.boolean() })),

    /** Recompose l'objet chez le stockage. **C'est la notification de fin.** */
    complete: oc
      .input(z.object({ uploadId: z.string() }))
      .output(z.object({ ok: z.boolean(), objectKey: z.string() })),

    /**
     * Renonce, et le dit.
     *
     * Un multipart abandonné en silence reste facturé indéfiniment chez le
     * stockage. La salle le signale donc quand elle peut ; le ménage du hub
     * couvre le cas où elle ne le peut plus.
     */
    abort: oc
      .input(z.object({ uploadId: z.string(), raison: z.string().max(300) }))
      .output(z.object({ ok: z.boolean() })),

    /** Ce que le hub sait des téléversements. `roomId` nul = toutes les salles. */
    uploads: oc
      .input(z.object({ roomId: roomIdSchema.nullable().default(null) }))
      .output(z.array(televersementVuSchema)),

    /**
     * Le stockage est-il configuré, et comment. Admin.
     *
     * Sans entrée : la console la demande pour savoir si elle a quelque chose à
     * montrer. Répondre « non configuré » vaut mieux qu'un panneau de réglages
     * dont chaque bouton échouerait — et dit du même coup quelles variables
     * manquent, ce qui ne se devine pas depuis un navigateur.
     */
    status: oc.output(
      z.object({
        /**
         * Le hub sait où écrire : clés **et** bucket.
         *
         * Un seul booléen pour les deux, parce que rien ne part sans les deux —
         * mais `endpoint` nul distingue les deux causes, et la console ne dit
         * pas la même chose dans un cas et dans l'autre : l'un se règle dans un
         * fichier d'environnement, l'autre dans le champ juste au-dessus.
         */
        configure: z.boolean(),
        /** `null` = aucune clé configurée sur ce hub, donc rien à régler ici. */
        endpoint: z.string().nullable(),
        bucket: z.string().nullable(),
        prefix: z.string().nullable(),
        politique: politiqueVodSchema,
      }),
    ),

    /**
     * Éprouve la connexion au stockage, pour de vrai. Admin.
     *
     * Elle ne sonde pas : elle **fait le vrai geste**. Ouvrir un téléversement,
     * signer une adresse de part, y écrire quelques octets, tout abandonner.
     * C'est la seule façon de distinguer un bucket qui existe d'un bucket où
     * l'on a le droit d'écrire, et une clé valide d'une signature juste.
     *
     * Elle ne lève jamais : le diagnostic **est** la réponse. Une erreur HTTP
     * ferait perdre l'étape à laquelle on s'est arrêté, qui est tout ce qu'on
     * venait chercher.
     *
     * Ce qu'elle ne dit pas, et qu'il faut savoir : elle éprouve le chemin
     * **depuis le hub**. Les salles écrivent les parts elles-mêmes, sur un autre
     * réseau et parfois derrière un autre pare-feu.
     */
    check: oc.output(controleStockageSchema),

    /**
     * Efface tout : le préfixe du bucket, et les rushes des salles. **Dev seulement.**
     *
     * Outil de développement, et refusé côté serveur hors `MODE=dev` — pas
     * seulement absent de la console. Une vue masquée reste à un `hidden` près
     * de quelqu'un qui inspecte la page ; celle-ci détruit une journée de
     * captation.
     *
     * Trois garde-fous, et chacun a sa raison :
     *
     * - **un préfixe est exigé.** Sans lui, « le préfixe » et « le bucket
     *   entier » sont la même chose, et un bucket partagé avec autre chose y
     *   passerait ;
     * - **côté salle, seul ce que l'application connaît est effacé** — les
     *   conteneurs vidéo, leurs sidecars, le fichier de verdicts. La racine des
     *   captations est parfois un disque partagé ;
     * - **`confirmation` doit valoir `RAZ`.** Le contrat le vérifie, donc le
     *   hub aussi : un appel direct, sans passer par la console et sa modale,
     *   ne peut pas se faire par distraction.
     */
    reset: oc
      .input(
        z.object({
          /** Recopié dans la console. Le contrat en fait une garde du hub. */
          confirmation: z.literal('RAZ'),
        }),
      )
      .output(
        z.object({
          /** Objets supprimés sous le préfixe. */
          objets: z.number().int().nonnegative(),
          /** Téléversements en cours abandonnés au passage. */
          multiparts: z.number().int().nonnegative(),
          /** Salles à qui l'ordre a été envoyé. Elles effacent chacune chez elles. */
          salles: z.number().int().nonnegative(),
        }),
      ),

    /**
     * Demande à une salle de téléverser. Admin.
     *
     * La console ne détient pas les fichiers : elle ne peut que demander. La
     * salle repasse par son propre régulateur — mais une demande explicite
     * vaut accord pour ne pas attendre la prochaine fenêtre.
     */
    request: oc
      .input(
        z.object({
          roomId: roomIdSchema,
          /** `null` = tout ce qui n'est pas encore monté. */
          file: z.string().max(400).nullable().default(null),
        }),
      )
      .output(z.object({ ok: z.boolean() })),
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
