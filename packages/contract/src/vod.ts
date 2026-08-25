import { z } from 'zod'
import { isoDateTimeSchema, roomIdSchema, sessionIdSchema } from './primitives.js'

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
