import { z } from 'zod'
import { programSchema } from '@cloudnord/program'
import { eventIdentitySchema, IDENTITE_PAR_DEFAUT } from './event-identity.js'
import {
  connectivitySchema,
  isoDateTimeSchema,
  modeExecutionSchema,
  roomIdSchema,
  sceneRoleSchema,
  sessionIdSchema,
} from './primitives.js'

/**
 * Mapping rôle → nom de scène OBS, par salle et par instance.
 * Validé contre `GetSceneList` à la connexion : un rôle non résolu passe en rouge
 * dans la régie, pour que le problème se voie à la répétition et pas pendant un talk.
 */
export const sceneRoleMapSchema = z.object({
  A: z.partialRecord(sceneRoleSchema, z.string()),
  B: z.partialRecord(sceneRoleSchema, z.string()),
})
export type SceneRoleMap = z.infer<typeof sceneRoleMapSchema>

export const obsEndpointSchema = z.object({
  url: z.string(),
  /** Jamais transmis en clair au-delà du hub ; stocké via `safeStorage` côté client. */
  password: z.string().nullable(),
})

export const roomConfigSchema = z.object({
  id: roomIdSchema,
  name: z.string(),
  /** `event.tracks[].id` de l'export amont : c'est le lien salle ↔ programme. */
  trackId: z.string(),
  obs: z.object({ A: obsEndpointSchema, B: obsEndpointSchema }),
  sceneRoles: sceneRoleMapSchema,
  /** Port du serveur HTTP local qui sert les pages display et le cache d'assets. */
  displayPort: z.number().int().positive().default(7788),
  /** Racine des enregistrements, pour le renommage et les sidecars. */
  recordingRoot: z.string().nullable().default(null),
  /**
   * Fragment court utilisé dans les noms de fichiers (`track1`).
   * Le nom complet de la salle donnerait des noms illisibles ; à défaut on le
   * dérive, mais le renseigner rend les rushes bien plus faciles à trier.
   */
  fileSlug: z.string().max(24).nullable().default(null),
  /** Clé de diffusion RTMP, poussée par le hub au moment du sync. */
  stream: z
    .object({ rtmpUrl: z.string(), streamKey: z.string() })
    .nullable()
    .default(null),
  /**
   * Salle dont cette salle peut relayer le flux (overflow, plateau).
   *
   * Le logiciel se contente de basculer sur le rôle `RELAY` ; l'acheminement
   * lui-même (NDI ou SRT) est une affaire de configuration OBS et de réseau.
   * Ce champ sert à l'annoncer en régie : « RELAY → Track #2 » plutôt qu'un
   * bouton dont personne ne sait ce qu'il montre.
   */
  relaySourceRoomId: roomIdSchema.nullable().default(null),
  /**
   * Projet OpenFeedback, **surcharge de salle**.
   *
   * Sert à fabriquer le QR « notez ce talk », **hors ligne** : OpenFeedback
   * réutilise les identifiants de session de l'export amont, donc l'adresse se
   * déduit du programme déjà en cache, sans clé d'API ni appel réseau le jour J.
   *
   * `null` — le cas normal — veut dire « celui de l'événement » : le hub
   * descend au `sync` la valeur de ses réglages. Le projet est une propriété de
   * l'événement, pas de la salle ; le renseigner ici ne sert qu'à une salle qui
   * doit pointer ailleurs, et se fait dans le ⚙ de la régie.
   */
  openFeedbackProjectId: z.string().nullable().default(null),
  /**
   * Au « Commencer », avertir si rien n'enregistre.
   *
   * L'oubli le plus coûteux de la journée : le talk se déroule, personne ne
   * s'en aperçoit, et il n'y a pas de VOD à rattraper le soir. Le geste de
   * lancer une conférence est le bon endroit pour poser la question — c'est le
   * seul moment où l'on sait qu'un talk commence.
   *
   * Activé par défaut. Se coupe pour une salle qui n'enregistre pas du tout,
   * où l'avertissement deviendrait un clic de plus à chaque conférence.
   */
  promptRecordingOnStart: z.boolean().default(true),
  /**
   * Scène prise automatiquement au « Commencer ».
   *
   * Lancer la conférence et passer à l'antenne sont deux gestes qui vont
   * ensemble ; les séparer laissait l'habillage à l'écran pendant les
   * premières phrases de l'intervenant. `null` désactive la bascule pour une
   * salle qui préfère garder la main.
   */
  sceneOnStart: sceneRoleSchema.nullable().default('LIVE'),
})
export type RoomConfig = z.infer<typeof roomConfigSchema>

/**
 * Ce qu'une salle a le droit de reconfigurer elle-même.
 *
 * Volontairement plus étroit que `roomConfigSchema`, et le reste ne s'y glisse
 * pas par accident : zod écarte les clés inconnues. Trois exclusions, chacune
 * pour sa raison.
 *
 * - `id`, `name`, `trackId` : l'identité de la salle vient du programme amont.
 *   La laisser réécrire depuis un poste couperait le lien salle ↔ track, et
 *   avec lui tout le programme affiché.
 * - `stream` : une clé de diffusion descend du hub vers sa salle, jamais
 *   l'inverse. Elle se saisit là où elle est déjà, sur le hub.
 *
 * Tout le reste est du réglage de poste — adresses OBS, noms de scènes, port,
 * dossier d'enregistrement — c'est-à-dire précisément ce qui se découvre en
 * salle, devant les machines, et pas au moment de créer les salles.
 */
const obsEndpointPatchSchema = z.object({
  url: z.string(),
  /**
   * Absent = inchangé.
   *
   * La régie ne reçoit jamais le mot de passe en clair — elle sait seulement
   * qu'il y en a un — donc elle ne peut pas le renvoyer tel quel. Sans cette
   * distinction entre « vide » et « absent », enregistrer un changement de port
   * effacerait le mot de passe au passage.
   */
  password: z.string().nullable().optional(),
})

export const roomConfigPatchSchema = z
  .object({
    obs: z.object({ A: obsEndpointPatchSchema, B: obsEndpointPatchSchema }),
    sceneRoles: sceneRoleMapSchema,
    displayPort: z.number().int().positive(),
    recordingRoot: z.string().nullable(),
    fileSlug: z.string().max(24).nullable(),
    relaySourceRoomId: roomIdSchema.nullable(),
    openFeedbackProjectId: z.string().nullable(),
    promptRecordingOnStart: z.boolean(),
    sceneOnStart: sceneRoleSchema.nullable(),
  })
  .partial()
export type RoomConfigPatch = z.infer<typeof roomConfigPatchSchema>

/**
 * Forme *avant* validation : les champs à valeur par défaut y sont facultatifs.
 * C'est ce qu'acceptent les écritures, pour ne pas obliger chaque appelant à
 * répéter des `null` que le schéma pose déjà.
 */
export type RoomConfigInput = z.input<typeof roomConfigSchema>

/**
 * Où en est une conférence.
 *
 * `scheduled` est l'état par défaut et n'est jamais stocké : on n'enregistre
 * que ce qui s'est produit.
 */
export const sessionStatusSchema = z.enum(['scheduled', 'running', 'ended'])
export type SessionStatus = z.infer<typeof sessionStatusSchema>

export const sessionStateSchema = z.object({
  sessionId: sessionIdSchema,
  roomId: roomIdSchema.nullable(),
  status: sessionStatusSchema,
  startedAt: isoDateTimeSchema.nullable(),
  endedAt: isoDateTimeSchema.nullable(),
  /** `auto` quand la règle horaire a clôturé le créneau, sinon l'opérateur. */
  decidedBy: z.string(),
})
export type SessionState = z.infer<typeof sessionStateSchema>

/**
 * Un compte de l'organisateur, affiché dans la boucle d'attente.
 *
 * L'export amont ne porte que les réseaux des **speakers** : ceux de
 * l'événement lui-même n'ont aucune source dans le programme, d'où ce réglage.
 * Réglage du hub et non constante du code : un handle change entre deux
 * éditions — et d'un événement à l'autre — et le corriger ne doit pas demander
 * de rejouer une release sur les machines de salle.
 */
export const socialLinkSchema = z.object({
  /** Nom du réseau, affiché tel quel : « Bluesky », « LinkedIn »… */
  network: z.string().min(1).max(40),
  /** Ce qu'on lit à l'écran et qu'on retape : « @exemple.fr ». */
  handle: z.string().min(1).max(80),
  url: z.url(),
})
export type SocialLink = z.infer<typeof socialLinkSchema>

/**
 * Réglages du hub modifiables en cours d'événement.
 *
 * La clôture automatique existe parce que personne ne pense à appuyer sur
 * « Terminer » quand un talk déborde et que la salle applaudit. Le délai de
 * grâce est réglable : cinq minutes conviennent à un format de 50 minutes,
 * beaucoup moins à un quickie de 20.
 */
/**
 * Ce qu'un navigateur veut être notifié, famille par famille.
 *
 * Trois crans plutôt qu'un interrupteur : sur l'export 2026, annoncer chaque
 * début, fin et fin proche fait **soixante-trois avis** dans la journée, et un
 * téléphone qui vibre soixante-trois fois finit en silencieux — auquel cas le
 * dépassement passe inaperçu lui aussi.
 *
 * `essentiel` ne contient que les écarts au script : quelque chose ne se passe
 * pas comme prévu et quelqu'un doit trancher. `tout` ajoute le rythme normal de
 * la journée, qu'on suit depuis un couloir.
 */
export const niveauNotifSchema = z.enum(['rien', 'essentiel', 'tout'])
export type NiveauNotif = z.infer<typeof niveauNotifSchema>

/**
 * Les deux familles d'avis.
 *
 * `technique` parle des machines — une salle qui se tait, une machine à
 * appairer. `exploitation` parle du déroulé — ce qui commence, finit, déborde.
 * Elles se règlent séparément parce qu'elles ne s'adressent pas au même
 * moment : l'une inquiète, l'autre rythme.
 */
export const niveauxNotifSchema = z.object({
  technique: niveauNotifSchema.default('essentiel'),
  exploitation: niveauNotifSchema.default('essentiel'),
})
export type NiveauxNotif = z.infer<typeof niveauxNotifSchema>

export const hubSettingsSchema = z.object({
  /**
   * Nom de l'événement, **s'il faut contredire le programme importé**.
   *
   * `null` — le cas normal — laisse le hub lire `event.name` du snapshot actif :
   * importer le programme d'un autre événement suffit alors à renommer le mur
   * public, la console, les écrans de salle et les notifications, sans toucher
   * une ligne de code ni une variable d'environnement.
   *
   * Le réglage sert quand l'export amont porte un nom interne (« CN26-prod »)
   * ou pas de nom du tout. Voir `resoudreIdentiteEvenement`.
   */
  eventName: z.string().max(80).nullable().default(null),
  /**
   * Nom court, là où l'année n'apprend rien : titre de fenêtre, notification.
   *
   * `null` le déduit du nom complet en retirant le millésime. À renseigner
   * quand la déduction se trompe — elle est volontairement timide.
   */
  eventShortName: z.string().max(40).nullable().default(null),
  /**
   * Projet OpenFeedback de l'événement.
   *
   * Au niveau du hub parce que c'est une propriété de l'événement, pas d'une
   * salle : le régler une fois vaut pour toutes. Il descend aux salles au
   * `sync`, où chacune peut encore le surcharger — voir
   * `roomConfig.openFeedbackProjectId`. Vide, aucun QR « notez ce talk » n'est
   * dessiné : pas de lien vaut mieux qu'un lien mort scanné en salle.
   */
  openFeedbackProjectId: z.string().max(80).nullable().default(null),
  autoEndEnabled: z.boolean().default(true),
  autoEndGraceMinutes: z.number().int().min(0).max(120).default(5),
  /**
   * Export « conference-center » que le hub réimporte.
   *
   * Réglage et non variable d'environnement : l'URL change quand le programme
   * change, c'est-à-dire pendant l'événement, et redémarrer le hub pour la
   * corriger est exactement ce qu'on ne peut pas faire ce jour-là.
   * `PROGRAM_SOURCE_URL` reste l'amorce du premier démarrage, puis ce réglage
   * fait foi.
   */
  programSourceUrl: z.url().nullable().default(null),
  /**
   * Comptes de l'organisateur, affichés dans la boucle d'attente des salles.
   *
   * Poussés aux salles au `sync` et gardés en cache local : la boucle tourne
   * pendant les pauses, c'est-à-dire exactement quand le réseau de l'événement
   * est le plus chargé, et un écran qui perd la moitié de son contenu parce que
   * le hub a mis trois secondes à répondre se voit de la salle entière.
   */
  socialLinks: z.array(socialLinkSchema).max(8).default([]),
})
export type HubSettings = z.infer<typeof hubSettingsSchema>
export type HubSettingsInput = z.input<typeof hubSettingsSchema>

/**
 * État d'une conférence, enrichi du programme.
 *
 * La console ne détient pas le programme : sans ces champs, elle ne pourrait
 * afficher qu'un identifiant opaque et serait incapable de calculer le temps
 * restant. Ils sont résolus côté hub, au moment de la lecture.
 */
export const sessionStateViewSchema = sessionStateSchema.extend({
  title: z.string().nullable(),
  roomName: z.string().nullable(),
  /** Horaires **prévus** au programme, pas les horaires réels. */
  scheduledStartsAt: isoDateTimeSchema.nullable(),
  scheduledEndsAt: isoDateTimeSchema.nullable(),
  /**
   * Temps restant sur le créneau prévu, d'après l'horloge du hub. Négatif = dépassement.
   *
   * Redondant avec `scheduledEndsAt` en apparence seulement : le soustraire
   * demande une heure de référence, et le navigateur n'a que la sienne.
   * L'horloge du hub peut être simulée — en développement l'écart se compte en
   * semaines — et c'est elle qui fait foi pour toute la journée. Même raison,
   * et même champ, que `roomStatus.currentSession.remainingMs`.
   */
  remainingMs: z.number().int().nullable().default(null),
})
export type SessionStateView = z.infer<typeof sessionStateViewSchema>

export const sessionOverrideSchema = z.object({
  sessionId: sessionIdSchema,
  status: z.enum(['delayed', 'cancelled', 'moved']),
  delayMinutes: z.number().int().nullable(),
  note: z.string().nullable(),
})

export const syncResultSchema = z.object({
  protocolVersion: z.number().int(),
  /** Hash du snapshot : le client ne retélécharge que s'il a changé. */
  contentHash: z.string(),
  /** Absent quand le client est déjà à jour (`since` == `contentHash`). */
  program: programSchema.nullable(),
  room: roomConfigSchema,
  overrides: z.array(sessionOverrideSchema),
  /** Base de l'offset d'horloge : les timecodes VOD en dépendent. */
  serverTime: isoDateTimeSchema,
  /**
   * Mode du hub.
   *
   * La salle le compare au sien et le signale s'ils divergent : un poste de
   * développement branché sur le hub de l'événement — ou l'inverse — doit se
   * voir avant qu'on s'en aperçoive dans les enregistrements.
   */
  mode: modeExecutionSchema.default('production'),
  /**
   * L'heure du hub est simulée.
   *
   * Propagé jusqu'à l'écran de régie : voir 11:00 un matin d'août sans
   * explication ferait douter de tout le reste.
   */
  simulatedClock: z.boolean().default(false),
  /**
   * Comptes de l'événement, pour la boucle d'attente.
   *
   * Descendus avec le reste plutôt que demandés à part : la salle doit pouvoir
   * dérouler sa boucle entière sans toucher au réseau une fois synchronisée.
   */
  socialLinks: z.array(socialLinkSchema).default([]),
  /**
   * Identité de l'événement, tranchée par le hub.
   *
   * Descendue et mise en cache comme le reste : la salle doit pouvoir titrer
   * ses fenêtres et sa boucle d'attente avant d'avoir joint qui que ce soit.
   * Résolue côté hub et non déduite du programme côté salle, pour que le
   * réglage qui contredit l'export amont vaille aussi sur les écrans.
   */
  event: eventIdentitySchema.default(IDENTITE_PAR_DEFAUT),
})

/** Vue hub d'une salle, alimentée par les heartbeats — l'écran de supervision. */
export const roomStatusSchema = z.object({
  roomId: roomIdSchema,
  name: z.string(),
  connectivity: connectivitySchema,
  lastSeenAt: isoDateTimeSchema.nullable(),
  sceneRole: sceneRoleSchema.nullable(),
  currentSessionId: sessionIdSchema.nullable(),
  recording: z.boolean(),
  streaming: z.boolean(),
  outboxDepth: z.number().int().nonnegative(),
  programContentHash: z.string().nullable(),
  /**
   * Ce qui se joue en ce moment, d'après le programme et l'heure du hub.
   *
   * Le titre, pas seulement l'identifiant : une console de supervision doit
   * répondre à « qu'est-ce qui se passe » sans qu'on aille chercher ailleurs.
   * Calculé sur le programme plutôt que sur ce que la salle a remonté — une
   * salle coupée doit continuer d'afficher ce qu'elle est censée diffuser.
   */
  currentSession: z
    .object({
      id: sessionIdSchema,
      title: z.string(),
      endsAt: isoDateTimeSchema.nullable(),
      /**
       * Temps restant sur le créneau, d'après l'horloge du hub. Négatif = dépassement.
       *
       * Redondant avec `endsAt` en apparence seulement : le soustraire demande
       * une heure de référence, et le navigateur n'a que la sienne. L'horloge du
       * hub peut être simulée — en développement l'écart se compte en semaines —
       * et c'est elle qui fait foi pour toute la journée. `null` sur un créneau
       * de fin inconnue, qu'on ne veut pas afficher comme « 0 min ».
       */
      remainingMs: z.number().int().nullable().default(null),
    })
    .nullable()
    .default(null),
  /**
   * Où en est la salle, en un mot — ce que peint la pastille des consoles.
   *
   * Calculé par le hub, comme `remainingMs` et pour la même raison : lui seul
   * a l'heure qui fait foi, et elle peut être simulée. Le déduire dans le
   * navigateur donnerait une couleur juste sur le poste de l'opérateur et
   * fausse partout ailleurs.
   *
   * Croise le programme et le cycle de vie des conférences (« Commencer » /
   * « Terminer » en régie). Le programme donne le créneau ; le cycle de vie
   * donne ce qui s'y joue vraiment. Sans lui, un créneau commencé que personne
   * n'a lancé se lisait « en cours », et une salle qui déborde n'existait pas —
   * passé l'heure de fin, le programme passe au créneau suivant.
   */
  conference: z
    .enum([
      'aucune',
      'pause',
      'pas-commencee',
      'retard',
      'en-cours',
      'fin-proche',
      'terminee',
      'depassement',
    ])
    .default('aucune'),
})
export type RoomStatus = z.infer<typeof roomStatusSchema>
