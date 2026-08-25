import { z } from 'zod'
import {
  isoDateTimeSchema,
  obsInstanceSchema,
  roomIdSchema,
  sessionIdSchema,
} from './primitives.js'

/**
 * Rapatriement des rushes vers un stockage S3.
 *
 * Le partage est net, et c'est lui qui tient la sécurité de tout le reste : le
 * **hub** détient les clés du bucket et ne les donne jamais ; la **salle**
 * détient les fichiers et ne sait rien du stockage. Elle demande, reçoit des
 * adresses signées à durée de vie courte, téléverse dessus, et dit où elle en
 * est. Une machine de salle volée ne donne accès à aucun bucket.
 */

/**
 * Ce qu'on téléverse pour une conférence.
 *
 * Les deux partent ensemble, à l'extension près : le sidecar porte titre,
 * intervenants, catégorie et marqueurs, et sans lui le rush arrive au montage
 * comme un fichier anonyme de trois gigaoctets.
 */
export const genreVodSchema = z.enum(['rush', 'sidecar'])
export type GenreVod = z.infer<typeof genreVodSchema>

/**
 * Où en est un téléversement.
 *
 * `abandonne` et `echoue` disent deux choses différentes : le premier a été
 * interrompu — salle éteinte, ménage du hub — et se reprend tel quel ; le
 * second a été refusé par le stockage, et se regarde avant d'être relancé.
 */
export const etatTeleversementSchema = z.enum([
  'attente',
  'en-cours',
  'termine',
  'abandonne',
  'echoue',
])
export type EtatTeleversement = z.infer<typeof etatTeleversementSchema>

/**
 * Le plan de travail que le hub rend à une salle.
 *
 * Deux modes, parce que deux fichiers très différents voyagent ici. Le sidecar
 * pèse quelques kilo-octets : une adresse, une requête, fini. Le rush pèse
 * plusieurs gigaoctets sur un réseau d'événement, c'est-à-dire qu'il *sera*
 * coupé — il part donc en parts, et une coupure ne perd que la part en cours.
 */
export const planTeleversementSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('direct'),
    uploadId: z.string(),
    url: z.url(),
    /** Passé cette heure, l'adresse ne vaut plus rien : il faut en redemander une. */
    expiresAt: isoDateTimeSchema,
  }),
  z.object({
    mode: z.literal('multipart'),
    uploadId: z.string(),
    taillePartOctets: z.number().int().positive(),
    parts: z.number().int().positive(),
    /**
     * Numéros de parts déjà arrivées chez le stockage.
     *
     * C'est ce qui fait de `vod.begin` une **reprise** et pas un
     * recommencement : une machine redémarrée en pleine montée redemande son
     * plan et repart d'où elle en était. Sans ce champ, une coupure à 90 %
     * d'un rush de trois gigaoctets coûterait les trois gigaoctets.
     */
    recues: z.array(z.number().int().positive()).default([]),
  }),
])
export type PlanTeleversement = z.infer<typeof planTeleversementSchema>

/** Une adresse signée pour une part, et sa date de péremption. */
export const partSigneeSchema = z.object({
  numero: z.number().int().positive(),
  url: z.url(),
  expiresAt: isoDateTimeSchema,
})
export type PartSignee = z.infer<typeof partSigneeSchema>

/**
 * Quand une salle a le droit de téléverser, et à quel rythme.
 *
 * Réglage du hub et non de chaque salle : c'est une décision d'exploitation —
 * « le réseau de l'événement est chargé, calmez-vous » — et la prendre trois
 * fois, machine par machine, un jour d'événement, n'arriverait jamais. Elle
 * descend au sync et vit dans le cache local, pour que le régulateur d'une
 * salle coupée continue de trancher.
 */
export const politiqueVodSchema = z.object({
  /**
   * Téléversement automatique.
   *
   * Éteint par défaut : le défaut doit être le cas où rien ne part sans qu'on
   * l'ait demandé. Une demande manuelle marche de toute façon, actif ou non.
   */
  actif: z.boolean().default(false),
  /**
   * Plafond de débit, en octets par seconde. `null` = pas de plafond.
   *
   * Le seul réglage qui protège l'uplink de l'événement, et le seul qu'on ait
   * envie de corriger en cours de journée — d'où sa place ici plutôt que dans
   * une variable d'environnement.
   */
  debitMaxOctetsS: z.number().int().positive().nullable().default(null),
  /** Au-delà, on laisse le processeur à l'encodeur. */
  cpuMax: z.number().min(0).max(1).default(0.7),
  /** Minutes avant la prochaine conférence pendant lesquelles on ne téléverse plus. */
  margeConferenceMinutes: z.number().int().min(0).max(120).default(10),
  /**
   * Taille d'une part, en mégaoctets.
   *
   * C'est aussi le grain du plafond de débit et celui de la reprise : trop
   * grand, une coupure coûte cher et le débit se règle par à-coups ; trop
   * petit, on multiplie les allers-retours. Huit est un compromis, et S3
   * n'accepte pas moins de cinq.
   */
  taillePartMo: z.number().int().min(5).max(64).default(8),
})
export type PolitiqueVod = z.infer<typeof politiqueVodSchema>
export type PolitiqueVodInput = z.input<typeof politiqueVodSchema>

/**
 * La politique quand personne n'a rien réglé.
 *
 * Constante nommée plutôt que littéral répété : elle sert de défaut aux
 * réglages du hub *et* de repli à une salle qui n'a jamais synchronisé, et les
 * deux doivent dire la même chose. Rien ne part automatiquement — c'est le
 * défaut prudent, celui qu'on veut trouver sur un hub qu'on vient d'allumer.
 */
export const POLITIQUE_VOD_PAR_DEFAUT: PolitiqueVod = politiqueVodSchema.parse({})

/** Ce que le hub descend aux salles au sync. */
export const vodSyncSchema = z.object({
  /** Le hub sait où envoyer : sinon, rien de tout ceci n'a de sens. */
  actif: z.boolean().default(false),
  politique: politiqueVodSchema,
  /**
   * Autorité de certification à ajouter pour joindre le stockage, au format PEM.
   *
   * `null` — le cas normal — s'en remet aux CA publiques que Node embarque. Le
   * champ existe pour les stockages internes, dont le certificat est signé par
   * une CA d'entreprise : Node n'utilise pas le magasin du système, et une
   * salle refuserait la connexion avec un `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`
   * que rien n'explique.
   *
   * Descendue par le hub plutôt que posée sur chaque machine : poser une
   * variable d'environnement sur trois postes Electron un matin d'événement est
   * un geste qui s'oublie sur le troisième, et l'oubli ne se découvre que le
   * soir, quand les rushes ne partent pas. Un certificat d'autorité est public
   * par construction — ce n'est pas un secret qu'on diffuse, c'est ce qui
   * permet d'en vérifier un.
   *
   * Elle ne vaut que pour les envois vers le stockage : rien ici ne change ce
   * que la salle accepte par ailleurs.
   */
  caCert: z.string().nullable().default(null),
})
export type VodSync = z.infer<typeof vodSyncSchema>

/** Une ligne de la vue « téléversements », pour la console et la régie. */
export const televersementVuSchema = z.object({
  roomId: roomIdSchema,
  roomName: z.string().nullable(),
  file: z.string(),
  kind: genreVodSchema,
  sessionId: sessionIdSchema.nullable(),
  objectKey: z.string(),
  state: etatTeleversementSchema,
  sizeBytes: z.number().int().nonnegative(),
  bytesSent: z.number().int().nonnegative(),
  /** Dernier débit constaté, en octets par seconde. `null` avant la première part. */
  debitOctetsS: z.number().int().nonnegative().nullable(),
  startedAt: isoDateTimeSchema.nullable(),
  lastProgressAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
})
export type TeleversementVu = z.infer<typeof televersementVuSchema>

/**
 * Une prise, telle que le hub la reconstitue depuis ce que la salle a remonté.
 *
 * Le hub n'a jamais vu le disque de la régie, et n'a aucun moyen de le lire :
 * les salles appellent, jamais l'inverse. Ce qu'il sait, il le tient des deux
 * événements que la salle émet en enregistrant — `recording.started` et
 * `recording.stopped` —, et ces deux-là suffisent : le second porte le chemin
 * du fichier écrit, sa durée, et si le sidecar a pu être écrit à côté. Une
 * ligne ici veut donc dire « un fichier existe sur la machine de la salle »,
 * pas « un fichier existe quelque part ».
 */
export const captationVueSchema = z.object({
  roomId: roomIdSchema,
  /** Laquelle des deux instances OBS a enregistré. */
  obs: obsInstanceSchema,
  startedAt: isoDateTimeSchema,
  /** `null` tant que la prise court : c'est exactement ce que dit `enCours`. */
  endedAt: isoDateTimeSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  /**
   * Chemin rendu par OBS, après renommage.
   *
   * `null` sur une prise qu'OBS a refusé de nommer — disque plein, processus
   * tué en plein arrêt. C'est précisément le cas qu'on veut voir avant de
   * démonter la salle : la prise a eu lieu, le fichier est introuvable.
   */
  file: z.string().nullable(),
  /**
   * Le sidecar a été écrit à côté du master.
   *
   * Sans lui le rush arrive au montage en fichier anonyme : ni titre, ni
   * intervenants, ni marqueurs. Le dire ici évite de le découvrir au montage.
   */
  sidecarWritten: z.boolean(),
  enCours: z.boolean(),
  /**
   * La prise n'a jamais été refermée, et une autre a démarré après elle.
   *
   * Ce n'est pas « en cours » : c'est une prise dont le hub n'a jamais entendu
   * l'arrêt — OBS relancé, machine de salle tuée, remise à zéro en plein
   * enregistrement. Les afficher toutes comme actives donnait, sur une salle de
   * développement de trois jours, une pile de faux « enregistrement en cours »
   * au-dessus de la seule ligne qui disait quelque chose.
   *
   * Elles restent listées : le hub sait qu'OBS a écrit, et un fichier orphelin
   * sur un disque qu'on s'apprête à débrancher mérite d'être vu. Mais elles se
   * disent pour ce qu'elles sont.
   */
  finInconnue: z.boolean().default(false),
  /**
   * Comment la prise a été rattachée au créneau.
   *
   * `session` : la régie l'a estampillée elle-même, c'est le cas normal et le
   * seul qui ne se discute pas. `horaire` : la prise ne porte aucun créneau —
   * enregistrement lancé à la main, hors du cycle de vie — mais elle recouvre
   * l'heure de celui-ci dans la même salle. Le dire plutôt que de le taire :
   * un rush existe, il est probablement le bon, et personne ne le retrouverait
   * s'il n'apparaissait nulle part.
   */
  rattachement: z.enum(['session', 'horaire']),
})
export type CaptationVue = z.infer<typeof captationVueSchema>

/**
 * Le dossier VOD d'une conférence : ce qui a été pris, ce qui est monté.
 *
 * Les deux moitiés répondent à deux questions qu'on pose l'une après l'autre un
 * jour d'événement — « est-ce qu'on l'a ? », puis « est-ce que c'est parti ? » —
 * et elles ne se déduisent pas l'une de l'autre : un rush enregistré peut
 * n'être jamais monté, et un téléversement peut courir sur un fichier dont la
 * prise s'est mal terminée.
 */
export const dossierVodSchema = z.object({
  sessionId: sessionIdSchema,
  roomId: roomIdSchema.nullable(),
  roomName: z.string().nullable(),
  /**
   * Le hub sait-il téléverser.
   *
   * Faux, « rien de monté » ne veut rien dire : ce n'est pas un retard, c'est
   * une fonctionnalité qui n'est pas branchée sur ce hub. La console ne dit
   * pas la même chose dans les deux cas.
   */
  stockageConfigure: z.boolean(),
  captations: z.array(captationVueSchema),
  televersements: z.array(televersementVuSchema),
})
export type DossierVod = z.infer<typeof dossierVodSchema>

/**
 * Les quatre étapes d'un contrôle de connexion, dans l'ordre où elles échouent.
 *
 * Un booléen ne servirait à rien : « ça ne marche pas » est précisément ce
 * qu'on savait déjà. Ce qu'il faut, c'est *où* ça s'arrête, parce que les
 * quatre ne se corrigent pas au même endroit — un pare-feu, une clé, un droit
 * sur le bucket, une signature.
 */
export const etapeControleSchema = z.enum(['joindre', 'authentifier', 'signer', 'nettoyer'])
export type EtapeControle = z.infer<typeof etapeControleSchema>

export const controleStockageSchema = z.object({
  ok: z.boolean(),
  etapes: z.array(
    z.object({
      nom: etapeControleSchema,
      ok: z.boolean(),
      /** Ce qui s'est passé, en clair. Le code du stockage y est repris tel quel. */
      detail: z.string().nullable(),
    }),
  ),
})
export type ControleStockage = z.infer<typeof controleStockageSchema>
