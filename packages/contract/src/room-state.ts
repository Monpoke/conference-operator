import { z } from 'zod'
import { ETATS_SALLE, STATUTS } from '@cloudnord/etat-salle'
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
import { POLITIQUE_VOD_PAR_DEFAUT, politiqueVodSchema, vodSyncSchema } from './vod.js'

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
   * Projet OpenFeedback, **écrit par le hub, jamais par la salle**.
   *
   * Sert à fabriquer le QR « notez ce talk », **hors ligne** : OpenFeedback
   * réutilise les identifiants de session de l'export amont, donc l'adresse se
   * déduit du programme déjà en cache, sans clé d'API ni appel réseau le jour J.
   * C'est pour cela que la valeur voyage jusqu'ici plutôt que d'être demandée
   * au moment de dessiner le QR.
   *
   * Le champ est absent de `roomConfigPatchSchema` : une régie ne peut pas
   * l'écrire, et il n'apparaît plus dans son ⚙. Le projet est une propriété de
   * l'**événement** — il se règle une fois dans la console, dans
   * `hubSettings.openFeedbackProjectId`, et descend résolu à chaque `sync`.
   *
   * Ce n'est pas une préférence de style : tant que deux endroits pouvaient
   * l'écrire, il a suffi qu'un opérateur le remplisse sur une seule machine
   * pour que cette salle-là ait des liens et pas les autres, sans que rien ne
   * dise pourquoi. Vingt-six créneaux muets sur vingt-sept.
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
 * - `openFeedbackProjectId` : propriété de l'**événement**, pas d'un poste. Il
 *   a été éditable ici, et le prix s'est vu : rempli sur la seule machine de la
 *   salle 1, il donnait des liens à cette salle et à aucune autre, sans que
 *   rien ne l'explique. Un réglage que deux endroits peuvent écrire finit
 *   toujours par n'être écrit qu'à un seul.
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
 *
 * La liste vient de `@cloudnord/etat-salle`, qui porte aussi les transitions
 * autorisées : le contrat et l'automate ne peuvent donc pas connaître des
 * états différents.
 */
export const sessionStatusSchema = z.enum(STATUTS)
export type SessionStatus = z.infer<typeof sessionStatusSchema>

/**
 * Ce qu'OpenFeedback sait des créneaux du programme.
 *
 * Trois issues, et les distinguer est tout l'intérêt : un projet introuvable
 * (`projetTrouve` faux) tue toutes les adresses d'un coup et se corrige d'un
 * champ ; un projet qui ne stocke pas ses talks (`talksConnus` nul) rend la
 * comparaison sans objet, et le dire vaut mieux que signaler vingt-sept
 * créneaux qui ne manquent pas ; sinon `manquants` nomme ceux dont le lien et
 * le QR mènent à une page vide.
 */
export const controleOpenFeedbackSchema = z.object({
  projet: z.string(),
  projetTrouve: z.boolean(),
  /**
   * Nombre de talks connus d'OpenFeedback, ou `null`.
   *
   * `null` ne veut pas dire zéro : il veut dire « OpenFeedback ne tient pas
   * cette liste », parce que le projet lit ses sessions d'une source externe.
   * Confondre les deux ferait crier au loup sur un événement parfaitement
   * configuré — et un contrôle qui crie au loup ne se relance jamais.
   */
  talksConnus: z.number().int().nonnegative().nullable(),
  manquants: z.array(
    z.object({
      sessionId: sessionIdSchema,
      title: z.string(),
      /** L'identifiant réellement servi : c'est lui qu'on est allé chercher. */
      feedbackId: z.string(),
    }),
  ),
  /** Ce qu'il faut en comprendre, en clair : la console l'affiche tel quel. */
  detail: z.string(),
})
export type ControleOpenFeedback = z.infer<typeof controleOpenFeedbackSchema>

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
   * Projet OpenFeedback de l'événement. **Seul endroit où il s'écrit.**
   *
   * Au niveau du hub parce que c'est une propriété de l'événement, pas d'une
   * salle : le régler une fois vaut pour toutes. Il descend résolu aux salles
   * au `sync`, et une régie ne peut plus le contredire — le champ a existé dans
   * son ⚙, et il a suffi qu'il soit rempli sur une seule machine pour que les
   * autres salles n'aient plus de liens du tout.
   *
   * Vide, aucun QR « notez ce talk » n'est dessiné nulle part : pas de lien
   * vaut mieux qu'un lien mort scanné en salle. Une chaîne blanche compte comme
   * vide — elle ne fabrique que des adresses `openfeedback.io///…`.
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
  /**
   * Bucket où atterrissent les rushes. `null` = aucun, et rien ne part.
   *
   * Ici et non dans l'environnement, à la différence des clés : un nom de
   * bucket n'est pas un secret, et c'est la partie qui change — d'une édition à
   * l'autre, ou le matin où l'on s'aperçoit qu'on visait celui de l'an dernier.
   */
  vodBucket: z.string().max(200).nullable().default(null),
  /**
   * Préfixe de rangement dans le bucket, sans barre finale.
   *
   * Le nom de fichier produit par la salle porte déjà date, salle, heure et
   * titre ; le préfixe ne sert qu'à faire tenir plusieurs éditions dans un même
   * bucket sans qu'elles se mélangent.
   */
  vodPrefix: z.string().max(200).nullable().default(null),
  vodPolitique: politiqueVodSchema.default(POLITIQUE_VOD_PAR_DEFAUT),
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

/**
 * Décision prise sur un créneau le jour J, sans réimport.
 *
 * `break` et `talk` corrigent ce que l'export ne dit pas. Le normaliseur n'a
 * qu'un signal pour trancher — un créneau **sans intervenant** est une pause —
 * et il se trompe dans les deux sens : une plénière annoncée avec un nom passe
 * pour une conférence de salle, une keynote dont le speaker n'est pas encore
 * annoncé passe pour un déjeuner.
 *
 * Le hub sert alors le programme avec le `kind` corrigé, et tout ce qui en
 * découle suit — titrage à l'antenne, cible de « Commencer », couleur de la
 * pastille, QR de feedback. Une surcharge qui dit ce que l'export dit déjà est
 * sans effet : voir `ProgramService.active`.
 *
 * Les trois autres sont déclarées mais pas encore appliquées.
 */
export const sessionOverrideSchema = z.object({
  sessionId: sessionIdSchema,
  status: z.enum(['talk', 'break', 'delayed', 'cancelled', 'moved']),
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
  /**
   * Rapatriement des rushes : le hub sait-il où les envoyer, et à quel rythme.
   *
   * Descendu et mis en cache comme le programme, et pour la même raison : le
   * régulateur d'une salle tranche plusieurs fois par minute, et il ne doit
   * jamais dépendre d'un appel réseau — surtout pas au moment précis où le
   * réseau est ce qu'on cherche à ménager. `null` quand le hub n'a pas de
   * stockage configuré.
   */
  vod: vodSyncSchema.nullable().default(null),
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
   * Le break de la salle, en cours ou imminent — ou `null`.
   *
   * À part de `conference`, et non un état de plus : les deux cohabitent. Une
   * conférence peut courir pendant que le déjeuner approche, et c'est même le
   * cas qui compte — celui où l'on décide de ne pas enchaîner.
   *
   * Calculé par le hub, comme le reste de cette structure : lui seul a l'heure
   * qui fait foi, et elle peut être simulée.
   */
  breakBadge: z
    .object({
      /** `a-venir` : il commence dans moins d'un quart d'heure. */
      state: z.enum(['en-cours', 'a-venir']),
      title: z.string(),
      startsAt: isoDateTimeSchema,
      /** Reprise : fin effective du break. `null` si rien ne le ferme. */
      endsAt: isoDateTimeSchema.nullable(),
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
  conference: z.enum(ETATS_SALLE).default('aucune'),
})
export type RoomStatus = z.infer<typeof roomStatusSchema>
