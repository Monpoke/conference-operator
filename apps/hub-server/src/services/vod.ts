import { and, desc, eq, lt, ne } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  DEFAULT_VOD_POLICY,
  type VodKind,
  type SignedPart,
  type UploadPlan,
  type VodPolicy,
  type StorageCheck,
  type UploadView,
} from '@cloudnord/contract'
import { vodUpload } from '@cloudnord/db/hub'
import type { HubDatabase } from '../db.js'
import type { Config } from '../config.js'
import { ClientS3, ErreurS3, transportNode, type ClesS3, type TransportS3 } from './s3.js'
import type { SettingsService } from './sessions.js'

/**
 * Rapatriement des rushes : le registre, et le ménage.
 *
 * Le hub tient ce registre parce qu'il tient les clés. C'est lui qui ouvre un
 * multipart chez le stockage, lui qui collecte les ETags — S3 les redemande
 * tous au moment de recomposer l'objet, et les perdre rend l'objet
 * irrécupérable alors que tous ses octets y sont déjà —, et lui qui abandonne
 * ce qui traîne.
 *
 * Le service n'existe pas quand le stockage n'est pas configuré : c'est
 * `null` dans le sac de services, et chaque procédure refuse alors en le
 * disant. Un hub sans S3 ne doit pas porter une demi-fonctionnalité.
 */

/** Adresses signées : assez pour un lot de parts, jamais pour la journée. */
const DUREE_SIGNATURE_S = 3600

/** Au-delà, la salle a probablement redémarré : le plan se rouvre. */
const EXPIRATION_MULTIPART_ORPHELIN_MS = 24 * 3600_000

/** Types que le stockage annoncera à qui téléchargera. */
const TYPES: Record<string, string> = {
  '.mkv': 'video/x-matroska',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.json': 'application/json',
}

export interface VodStatus {
  configure: boolean
  endpoint: string | null
  bucket: string | null
  prefix: string | null
  politique: VodPolicy
}

export function clesS3(config: Config, caCert: string | null = null): ClesS3 | null {
  if (config.s3Endpoint == null || config.s3AccessKeyId == null || config.s3SecretAccessKey == null) {
    return null
  }
  return {
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    accessKeyId: config.s3AccessKeyId,
    secretAccessKey: config.s3SecretAccessKey,
    forcePathStyle: config.s3ForcePathStyle,
    caCert,
  }
}

/** Erreur de domaine : le hub sait signer, mais il ne sait pas encore où écrire. */
export class StockageIncomplet extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StockageIncomplet'
  }
}

export class VodService {
  private menage: NodeJS.Timeout | null = null

  constructor(
    private readonly db: HubDatabase,
    private readonly settings: SettingsService,
    private readonly cles: ClesS3,
    private readonly abandonMinutes: number,
    private readonly nowIso: () => string,
    private readonly onLog: (
      niveau: 'info' | 'warn',
      message: string,
      contexte?: unknown,
    ) => void = () => {},
    private readonly transport: TransportS3 = transportNode,
  ) {}

  /** Adresse du stockage, pour la nommer dans un message d'erreur. */
  endpoint(): string {
    return this.cles.endpoint
  }

  /**
   * Ce que le hub descend aux salles au sync.
   *
   * La CA voyage avec : c'est elle qui évite d'aller poser une variable
   * d'environnement sur chaque machine de salle. Les clés, elles, ne descendent
   * jamais — la salle ne reçoit que des adresses déjà signées.
   */
  sync(): { actif: boolean; politique: VodPolicy; caCert: string | null } {
    return { actif: true, politique: this.politique(), caCert: this.cles.caCert ?? null }
  }

  politique(): VodPolicy {
    return this.settings.get().vodPolitique ?? DEFAULT_VOD_POLICY
  }

  /** Le bucket est-il réglé ? Les clés ne suffisent pas : il faut savoir où écrire. */
  pret(): boolean {
    const bucket = this.settings.get().vodBucket
    return bucket != null && bucket.trim().length > 0
  }

  status(): VodStatus {
    const reglages = this.settings.get()
    return {
      configure: this.pret(),
      endpoint: this.cles.endpoint,
      bucket: reglages.vodBucket,
      prefix: reglages.vodPrefix,
      politique: this.politique(),
    }
  }

  /**
   * Éprouve la connexion, en faisant le vrai geste.
   *
   * Ouvrir un multipart, signer une adresse de part, y écrire quelques octets,
   * tout abandonner. Rien de moins ne répond à la question : un `HEAD` sur le
   * bucket dirait qu'il existe, pas qu'on a le droit d'y écrire ; et une clé
   * acceptée ne prouve pas qu'une **adresse presignée** sera acceptée — or
   * c'est la signature des parts qui porte tout le téléversement, et c'est la
   * plus délicate.
   *
   * Rien ne reste : un multipart abandonné ne laisse aucun objet, et c'est le
   * même appel que celui du ménage.
   *
   * Ne lève jamais. Le diagnostic **est** la réponse : une erreur HTTP ferait
   * perdre l'étape à laquelle on s'est arrêté, qui est tout ce qu'on venait
   * chercher.
   */
  async check(): Promise<StorageCheck> {
    const etapes: StorageCheck['etapes'] = []
    /**
     * L'action S3 que chaque étape exerce.
     *
     * Un `AccessDenied` nu ne dit pas *laquelle* manque, et une policy en
     * autorise cinq ou six : on relit la liste sans savoir ce qu'on y cherche.
     * Ce sont les deux dernières qui manquent le plus souvent, parce qu'aucune
     * n'est évidente — `PutObject` couvre l'ouverture d'un multipart et l'envoi
     * des parts, mais **pas** leur abandon, qui a son action propre.
     */
    const ACTION: Record<string, string> = {
      joindre: 's3:ListBucket',
      authentifier: 's3:PutObject (CreateMultipartUpload)',
      signer: 's3:PutObject (UploadPart)',
      nettoyer: 's3:AbortMultipartUpload',
    }
    const franchie = (nom: StorageCheck['etapes'][number]['nom']): void => {
      etapes.push({ nom, ok: true, detail: null })
    }
    const echouee = (
      nom: StorageCheck['etapes'][number]['nom'],
      cause: unknown,
    ): StorageCheck => {
      const brut =
        cause instanceof ErreurS3 ? `${cause.code} : ${cause.message}` : causeLisible(cause)
      /**
       * Un défaut de confiance TLS se dit avec sa réparation.
       *
       * `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` est exact et illisible : il ne dit
       * pas que Node ignore le magasin du système, ni où poser la CA. Et il ne
       * se cherche pas au même endroit selon qu'une CA est déjà configurée — si
       * elle l'est, c'est qu'elle ne couvre pas ce certificat, ce qui est une
       * tout autre piste que « il en manque une ».
       */
      const certificat = /CERT|SELF_SIGNED|SIGNATURE/.test(brut)
        ? `${brut} — ${
            this.cles.caCert == null
              ? "le certificat du stockage n'est signé par aucune CA publique : renseigner S3_CA_CERT sur le hub"
              : 'la CA fournie par S3_CA_CERT ne couvre pas ce certificat'
          }`
        : brut
      /**
       * Un refus de droits se dit avec l'action qu'il manquait.
       *
       * `AccessDenied` seul fait relire une policy sans savoir ce qu'on y
       * cherche. Nommer l'action transforme une enquête en une ligne à ajouter.
       */
      const detail = /AccessDenied|Forbidden|HTTP 403/.test(certificat)
        ? `${certificat} — action requise : ${ACTION[nom] ?? '?'}`
        : certificat
      etapes.push({ nom, ok: false, detail })
      return { ok: false, etapes }
    }

    if (!this.pret()) {
      return echouee('joindre', new Error("aucun bucket réglé : renseignez-le avant d'éprouver la connexion"))
    }

    /**
     * Joindre, d'abord et séparément.
     *
     * Une requête nue sur l'adresse du stockage : le refus qu'elle vaudra —
     * 403, 404, peu importe — prouve déjà ce qu'on cherche, à savoir que le
     * réseau passe, que le nom résout et que le certificat est accepté. Sans
     * cette étape à part, un pare-feu et une clé fausse se seraient présentés
     * de la même façon, et on les aurait cherchés au même endroit.
     */
    try {
      await this.transport(new URL(this.cles.endpoint).origin, {
        method: 'GET',
        headers: {},
        // La CA vaut ici comme partout ailleurs. L'oublier faisait échouer le
        // contrôle sur un défaut de confiance que la configuration corrigeait
        // déjà — un diagnostic qui accuse ce qu'on vient de réparer est pire
        // que pas de diagnostic.
        ca: this.cles.caCert ?? null,
      })
      franchie('joindre')
    } catch (cause) {
      return echouee('joindre', cause)
    }

    const client = this.client()
    const prefixe = (this.settings.get().vodPrefix ?? '').replace(/^\/+|\/+$/g, '')
    const key = [prefixe, '.controle-de-connexion', ulid()].filter((part) => part !== '').join('/')

    let uploadId: string
    try {
      uploadId = await client.creerMultipart(key, 'application/octet-stream')
      franchie('authentifier')
    } catch (cause) {
      return echouee('authentifier', cause)
    }

    try {
      const reponse = await this.transport(client.presignerPart(key, uploadId, 1, 300), {
        method: 'PUT',
        headers: {},
        body: 'controle-de-connexion',
        ca: this.cles.caCert ?? null,
      })
      if (reponse.status >= 300) {
        throw new ErreurS3(
          `HTTP ${reponse.status}`,
          "le stockage a refusé l'adresse signée",
          reponse.status,
        )
      }
      franchie('signer')
    } catch (cause) {
      const echec = echouee('signer', cause)
      // Abandonner quand même, et le dire : un multipart ouvert par un contrôle
      // raté resterait facturé, ce qui serait un comble pour une fonctionnalité
      // dont la moitié est un ménage. L'étape est rendue après celle qui a
      // échoué, dans l'ordre où les choses se sont passées.
      await this.abandonnerChezS3(key, uploadId)
      franchie('nettoyer')
      return echec
    }

    try {
      await client.abandonnerMultipart(key, uploadId)
      franchie('nettoyer')
    } catch (cause) {
      return echouee('nettoyer', cause)
    }

    return { ok: true, etapes }
  }

  /**
   * Vide le préfixe du bucket. **Développement seulement** — le routeur le garde.
   *
   * Un préfixe est **exigé**, et c'est le garde-fou qui compte : sans lui,
   * « vider le préfixe » et « vider le bucket » sont le même geste, et un
   * bucket qui sert aussi à autre chose y passerait. Refuser est le seul
   * comportement rattrapable des deux.
   *
   * Les multiparts ouverts partent avec : ils ne figurent dans aucune liste
   * d'objets — ils n'existent pas encore comme objets — et survivraient donc à
   * une remise à zéro qui prétend tout effacer.
   */
  async raz(): Promise<{ objets: number; multiparts: number }> {
    const prefixe = (this.settings.get().vodPrefix ?? '').replace(/^\/+|\/+$/g, '')
    if (prefixe === '') {
      throw new StockageIncomplet(
        "aucun préfixe réglé : la remise à zéro effacerait le bucket entier, ce qu'elle refuse de faire",
      )
    }
    const client = this.client()
    const sous = `${prefixe}/`

    const cles = await client.listerObjets(sous)
    for (const key of cles) await client.supprimerObjet(key)

    const ouverts = await client.listerMultiparts(sous)
    for (const multipart of ouverts) {
      await this.abandonnerChezS3(multipart.key, multipart.uploadId)
    }

    // Le registre part avec : garder des lignes « terminé » pointant des objets
    // qui n'existent plus ferait dire à la console que tout est rapatrié.
    this.db.delete(vodUpload).run()

    this.onLog('info', 'remise à zéro du stockage', {
      prefixe: sous,
      objets: cles.length,
      multiparts: ouverts.length,
    })
    return { objets: cles.length, multiparts: ouverts.length }
  }

  private client(): ClientS3 {
    const bucket = this.settings.get().vodBucket
    if (bucket == null || bucket.trim().length === 0) {
      throw new StockageIncomplet(
        'aucun bucket réglé : console → VOD → Stockage, avant de téléverser quoi que ce soit',
      )
    }
    return new ClientS3(this.cles, bucket.trim(), this.transport)
  }

  /**
   * `<prefixe>/<aaaa-mm-jj>/<salle>/<fichier>`.
   *
   * Le nom de fichier produit par la salle porte déjà date, salle, heure et
   * titre : le préfixe ne sert qu'à faire tenir plusieurs éditions dans un même
   * bucket. La date en tête vient du **nom du fichier** quand il en porte une,
   * et de l'heure du hub sinon — ranger un rush du 30 octobre sous la date du
   * jour où on l'a rapatrié le rendrait introuvable.
   */
  cleObjet(roomId: string, file: string): string {
    const nom = file.split('/').pop() ?? file
    const date = nom.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? this.nowIso().slice(0, 10)
    const prefixe = (this.settings.get().vodPrefix ?? '').replace(/^\/+|\/+$/g, '')
    return [prefixe, date, roomId, nom].filter((part) => part !== '').join('/')
  }

  private typeDe(file: string): string {
    const point = file.lastIndexOf('.')
    return (point >= 0 ? TYPES[file.slice(point).toLowerCase()] : undefined) ?? 'application/octet-stream'
  }

  private partsDe(json: string): { n: number; etag: string }[] {
    try {
      const lu: unknown = JSON.parse(json)
      return Array.isArray(lu) ? (lu as { n: number; etag: string }[]) : []
    } catch {
      return []
    }
  }

  /**
   * Ouvre — ou reprend — le téléversement d'un fichier.
   *
   * L'unicité `(salle, fichier)` en base fait tout le travail : rappeler sur un
   * fichier déjà en cours retrouve la ligne, rend le même plan et la liste des
   * parts arrivées. C'est ce qui permet à une machine redémarrée en pleine
   * montée de repartir de la part suivante plutôt que du premier octet — sur un
   * rush de trois gigaoctets et un réseau d'événement, c'est la différence
   * entre « ça finira » et « ça ne finira jamais ».
   */
  async begin(entree: {
    roomId: string
    file: string
    sizeBytes: number
    kind: VodKind
    sessionId: string | null
  }): Promise<UploadPlan> {
    const client = this.client()
    const existante = this.db
      .select()
      .from(vodUpload)
      .where(and(eq(vodUpload.roomId, entree.roomId), eq(vodUpload.file, entree.file)))
      .get()

    // Déjà monté, et la taille n'a pas bougé : rien à refaire. Un rush ne se
    // réécrit pas — s'il a changé de taille, c'est un autre fichier sous le même
    // nom, et il repart de zéro.
    if (
      existante != null &&
      existante.state === 'termine' &&
      existante.sizeBytes === entree.sizeBytes
    ) {
      return existante.s3UploadId == null
        ? {
            mode: 'direct',
            uploadId: existante.id,
            url: client.presignerPut(existante.objectKey, DUREE_SIGNATURE_S),
            expiresAt: new Date(Date.now() + DUREE_SIGNATURE_S * 1000).toISOString(),
          }
        : {
            mode: 'multipart',
            uploadId: existante.id,
            taillePartOctets: existante.partSizeBytes,
            parts: Math.max(1, Math.ceil(existante.sizeBytes / existante.partSizeBytes)),
            recues: this.partsDe(existante.partsJson).map((part) => part.n),
          }
    }

    const taillePart = Math.max(5, this.politique().taillePartMo) * 1024 * 1024
    const reprenable =
      existante != null &&
      existante.sizeBytes === entree.sizeBytes &&
      existante.s3UploadId != null &&
      existante.partSizeBytes === taillePart &&
      existante.state !== 'termine'

    if (reprenable && existante != null) {
      this.db
        .update(vodUpload)
        .set({ state: 'en-cours', lastProgressAt: this.nowIso(), lastError: null })
        .where(eq(vodUpload.id, existante.id))
        .run()
      return {
        mode: 'multipart',
        uploadId: existante.id,
        taillePartOctets: existante.partSizeBytes,
        parts: Math.max(1, Math.ceil(entree.sizeBytes / existante.partSizeBytes)),
        recues: this.partsDe(existante.partsJson).map((part) => part.n),
      }
    }

    // Un plan qu'on remplace laisse un multipart ouvert chez le stockage : on
    // l'abandonne tout de suite plutôt que d'attendre le ménage, sinon changer
    // la taille de part dans la console facturerait un rush entier par essai.
    if (existante?.s3UploadId != null) {
      await this.abandonnerChezS3(existante.objectKey, existante.s3UploadId)
    }

    const objectKey = this.cleObjet(entree.roomId, entree.file)
    const direct = entree.kind === 'sidecar' || entree.sizeBytes <= taillePart
    const id = existante?.id ?? ulid()
    const s3UploadId = direct
      ? null
      : await client.creerMultipart(objectKey, this.typeDe(entree.file))

    const ligne = {
      id,
      roomId: entree.roomId,
      file: entree.file,
      kind: entree.kind,
      sessionId: entree.sessionId,
      objectKey,
      sizeBytes: entree.sizeBytes,
      partSizeBytes: taillePart,
      bytesSent: 0,
      s3UploadId,
      partsJson: '[]',
      state: 'en-cours',
      debitOctetsS: null,
      startedAt: this.nowIso(),
      lastProgressAt: this.nowIso(),
      finishedAt: null,
      attempts: (existante?.attempts ?? 0) + 1,
      lastError: null,
    }
    this.db
      .insert(vodUpload)
      .values(ligne)
      .onConflictDoUpdate({ target: vodUpload.id, set: ligne })
      .run()

    if (direct) {
      return {
        mode: 'direct',
        uploadId: id,
        url: client.presignerPut(objectKey, DUREE_SIGNATURE_S),
        expiresAt: new Date(Date.now() + DUREE_SIGNATURE_S * 1000).toISOString(),
      }
    }
    return {
      mode: 'multipart',
      uploadId: id,
      taillePartOctets: taillePart,
      parts: Math.max(1, Math.ceil(entree.sizeBytes / taillePart)),
      recues: [],
    }
  }

  /** Signe un lot de parts. Toujours à la demande : une adresse signée périme. */
  parts(roomId: string, uploadId: string, numeros: number[]): SignedPart[] {
    const ligne = this.ligne(roomId, uploadId)
    if (ligne.s3UploadId == null) {
      throw new StockageIncomplet('ce téléversement est direct : il n\'a pas de parts')
    }
    const client = this.client()
    const expiresAt = new Date(Date.now() + DUREE_SIGNATURE_S * 1000).toISOString()
    return numeros.map((numero) => ({
      numero,
      url: client.presignerPart(ligne.objectKey, ligne.s3UploadId as string, numero, DUREE_SIGNATURE_S),
      expiresAt,
    }))
  }

  /** Une part est arrivée : on retient son ETag, sans lequel rien ne se recompose. */
  progress(entree: {
    roomId: string
    uploadId: string
    numero: number
    etag: string
    octets: number
    dureeMs: number
  }): void {
    const ligne = this.ligne(entree.roomId, entree.uploadId)
    const parts = this.partsDe(ligne.partsJson).filter((part) => part.n !== entree.numero)
    parts.push({ n: entree.numero, etag: entree.etag })

    this.db
      .update(vodUpload)
      .set({
        partsJson: JSON.stringify(parts.sort((a, b) => a.n - b.n)),
        // Recompté sur les parts acquittées, pas cumulé : une part rejouée
        // après échec ferait sinon dépasser la taille du fichier, et la console
        // afficherait 112 %.
        bytesSent: Math.min(ligne.sizeBytes, parts.length * ligne.partSizeBytes),
        debitOctetsS:
          entree.dureeMs > 0 ? Math.round((entree.octets * 1000) / entree.dureeMs) : null,
        lastProgressAt: this.nowIso(),
        state: 'en-cours',
        lastError: null,
      })
      .where(eq(vodUpload.id, ligne.id))
      .run()
  }

  async complete(roomId: string, uploadId: string): Promise<string> {
    const ligne = this.ligne(roomId, uploadId)
    if (ligne.s3UploadId != null) {
      await this.client().terminerMultipart(
        ligne.objectKey,
        ligne.s3UploadId,
        this.partsDe(ligne.partsJson),
      )
    }
    this.db
      .update(vodUpload)
      .set({
        state: 'termine',
        bytesSent: ligne.sizeBytes,
        finishedAt: this.nowIso(),
        lastProgressAt: this.nowIso(),
        lastError: null,
      })
      .where(eq(vodUpload.id, ligne.id))
      .run()
    this.onLog('info', 'rush téléversé', { roomId, file: ligne.file, objectKey: ligne.objectKey })
    return ligne.objectKey
  }

  async abort(roomId: string, uploadId: string, raison: string): Promise<void> {
    const ligne = this.ligne(roomId, uploadId)
    if (ligne.s3UploadId != null) {
      await this.abandonnerChezS3(ligne.objectKey, ligne.s3UploadId)
    }
    this.db
      .update(vodUpload)
      .set({ state: 'abandonne', lastError: raison, finishedAt: this.nowIso() })
      .where(eq(vodUpload.id, ligne.id))
      .run()
  }

  uploads(roomId: string | null, nomDeSalle: (id: string) => string | null): UploadView[] {
    const lignes = roomId == null
      ? this.db.select().from(vodUpload).orderBy(desc(vodUpload.startedAt)).all()
      : this.db
          .select()
          .from(vodUpload)
          .where(eq(vodUpload.roomId, roomId))
          .orderBy(desc(vodUpload.startedAt))
          .all()

    return lignes.map((ligne) => ({
      roomId: ligne.roomId,
      roomName: nomDeSalle(ligne.roomId),
      file: ligne.file,
      kind: ligne.kind as VodKind,
      sessionId: ligne.sessionId,
      objectKey: ligne.objectKey,
      state: ligne.state as UploadView['state'],
      sizeBytes: ligne.sizeBytes,
      bytesSent: ligne.bytesSent,
      debitOctetsS: ligne.debitOctetsS,
      startedAt: ligne.startedAt,
      lastProgressAt: ligne.lastProgressAt,
      finishedAt: ligne.finishedAt,
      attempts: ligne.attempts,
      lastError: ligne.lastError,
    }))
  }

  /**
   * Les téléversements d'**une** conférence, toutes salles et tous essais.
   *
   * Sans filtre de salle : un créneau relayé, ou une salle renommée en cours de
   * route, laisse des lignes sous deux identifiants, et n'en montrer qu'une
   * moitié serait pire que de ne rien montrer. Le rush et son sidecar arrivent
   * ensemble, les plus récents d'abord — ce qui met en tête l'essai en cours
   * quand un premier a échoué.
   */
  pourSession(sessionId: string, nomDeSalle: (id: string) => string | null): UploadView[] {
    return this.uploads(null, nomDeSalle).filter((ligne) => ligne.sessionId === sessionId)
  }

  /**
   * Abandonne un multipart sans jamais lever.
   *
   * Le ménage tourne en fond : un stockage momentanément injoignable ne doit
   * pas arrêter la boucle, et la ligne sera reprise au tour suivant. C'est la
   * même règle que partout ailleurs ici.
   */
  private async abandonnerChezS3(objectKey: string, s3UploadId: string): Promise<void> {
    try {
      await this.client().abandonnerMultipart(objectKey, s3UploadId)
    } catch (cause) {
      const code = cause instanceof ErreurS3 ? cause.code : (cause as Error).message
      this.onLog('warn', 'abandon du multipart refusé par le stockage', { objectKey, code })
    }
  }

  private ligne(roomId: string, uploadId: string) {
    const trouvee = this.db
      .select()
      .from(vodUpload)
      .where(and(eq(vodUpload.id, uploadId), eq(vodUpload.roomId, roomId)))
      .get()
    if (trouvee == null) {
      throw new StockageIncomplet('téléversement inconnu — le redemander par `vod.begin`')
    }
    return trouvee
  }

  /**
   * Une passe de ménage : ce qui ne progresse plus est abandonné.
   *
   * Une salle éteinte en pleine montée ne dit rien. Sans cette échéance, son
   * multipart resterait ouvert — et facturé — indéfiniment, et personne ne le
   * saurait avant la facture.
   */
  async menageUneFois(): Promise<number> {
    if (!this.pret()) return 0
    const limite = new Date(Date.now() - this.abandonMinutes * 60_000).toISOString()
    const muettes = this.db
      .select()
      .from(vodUpload)
      .where(and(eq(vodUpload.state, 'en-cours'), lt(vodUpload.lastProgressAt, limite)))
      .all()

    for (const ligne of muettes) {
      if (ligne.s3UploadId != null) await this.abandonnerChezS3(ligne.objectKey, ligne.s3UploadId)
      this.db
        .update(vodUpload)
        .set({
          state: 'abandonne',
          lastError: `sans nouvelle depuis ${this.abandonMinutes} min`,
          finishedAt: this.nowIso(),
        })
        .where(eq(vodUpload.id, ligne.id))
        .run()
    }
    if (muettes.length > 0) {
      this.onLog('info', 'téléversements muets abandonnés', { nombre: muettes.length })
    }
    return muettes.length
  }

  /**
   * Les multiparts que plus personne ne réclame.
   *
   * Le registre ne connaît que ce que *ce* hub a ouvert. Une base recréée — le
   * cas d'école — laisse chez le stockage des multiparts dont plus aucune ligne
   * ne parle, et que rien n'abandonnerait jamais. On ne touche qu'à ceux de
   * plus de vingt-quatre heures : en deçà, une salle est peut-être en train de
   * les alimenter, et un rush de deux heures se monte lentement.
   */
  async menageDesOrphelins(): Promise<number> {
    if (!this.pret()) return 0
    const prefixe = (this.settings.get().vodPrefix ?? '').replace(/^\/+|\/+$/g, '')
    let ouverts
    try {
      ouverts = await this.client().listerMultiparts(prefixe === '' ? '' : `${prefixe}/`)
    } catch (cause) {
      const code = cause instanceof ErreurS3 ? cause.code : (cause as Error).message
      this.onLog('warn', 'inventaire des téléversements ouverts impossible', { code })
      return 0
    }

    const connus = new Set(
      this.db
        .select({ s3UploadId: vodUpload.s3UploadId })
        .from(vodUpload)
        .where(ne(vodUpload.state, 'termine'))
        .all()
        .map((ligne) => ligne.s3UploadId)
        .filter((valeur): valeur is string => valeur != null),
    )

    const limite = Date.now() - EXPIRATION_MULTIPART_ORPHELIN_MS
    let abandonnes = 0
    for (const ouvert of ouverts) {
      if (connus.has(ouvert.uploadId)) continue
      // Sans date d'ouverture on ne tranche pas : mieux vaut laisser traîner un
      // multipart que d'en supprimer un qu'une salle alimente en ce moment.
      const ouvertA = ouvert.initiatedAt == null ? null : Date.parse(ouvert.initiatedAt)
      if (ouvertA == null || Number.isNaN(ouvertA) || ouvertA > limite) continue
      await this.abandonnerChezS3(ouvert.key, ouvert.uploadId)
      abandonnes += 1
    }
    if (abandonnes > 0) {
      this.onLog('info', 'multiparts orphelins abandonnés', { nombre: abandonnes })
    }
    return abandonnes
  }

  /**
   * Démarre la boucle de ménage.
   *
   * Dix minutes, et non quinze secondes comme la supervision : rien ici ne se
   * regarde en direct, et interroger le stockage en boucle coûterait des
   * requêtes facturées pour un problème qui se mesure en heures.
   */
  demarrerMenage(intervalMs = 600_000): void {
    if (this.menage != null) return
    let enCours = false
    const passe = (): void => {
      if (enCours) return
      enCours = true
      void this.menageUneFois()
        .catch(() => {})
        .finally(() => {
          enCours = false
        })
    }
    this.menage = setInterval(passe, intervalMs)
    this.menage.unref?.()
  }

  arreterMenage(): void {
    if (this.menage != null) clearInterval(this.menage)
    this.menage = null
  }
}

/**
 * Le vrai motif d'un échec réseau, sous la couche du transport.
 *
 * Le code errno distingue un service éteint (`ECONNREFUSED`) d'un nom qui ne
 * résout pas (`ENOTFOUND`), d'un certificat qu'on ne sait pas vérifier
 * (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`) et d'un pare-feu qui laisse pendre
 * (`ETIMEDOUT`). Quatre pannes, quatre endroits différents où aller regarder.
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
