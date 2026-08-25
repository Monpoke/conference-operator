import { createHash, createHmac } from 'node:crypto'
import { request as requeteHttp } from 'node:http'
import { request as requeteHttps } from 'node:https'

/**
 * Le strict nécessaire de S3, signé à la main.
 *
 * Le SDK officiel pèse une quinzaine de mégaoctets et une famille de paquets
 * qui bouge vite, pour six opérations dont aucune ne dépasse une requête HTTP.
 * SigV4 tient en une centaine de lignes de `node:crypto`, et le dépôt n'a ni
 * bundler ni SDK — en ajouter un ici serait le premier.
 *
 * La signature est vérifiée contre les vecteurs officiels d'AWS
 * (`apps/hub-server/test/s3.test.ts`) : c'est la seule façon d'être sûr d'un
 * algorithme dont la moindre erreur ne se manifeste que par un
 * `SignatureDoesNotMatch` sans détail.
 */

export interface ClesS3 {
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** `endpoint/bucket/cle` plutôt que `bucket.endpoint/cle`. */
  forcePathStyle: boolean
  /**
   * Autorité de certification supplémentaire, au format PEM.
   *
   * Pour un stockage interne dont le certificat est signé par une CA
   * d'entreprise : Node n'utilise pas le magasin du système, et la connexion
   * échouerait sur `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.
   */
  caCert?: string | null
}

/** Ce qu'un transport rend. Volontairement pauvre : c'est tout ce qu'on lit. */
export interface ReponseS3 {
  status: number
  corps: string
}

/**
 * Un appel HTTP, injectable.
 *
 * `node:https` plutôt que `fetch`, pour une seule raison : `fetch` ne laisse
 * pas ajouter une autorité de certification. Le `Agent` d'undici le permettrait,
 * mais Node ne l'expose pas publiquement et l'ajouter en dépendance
 * reviendrait à embarquer une seconde fois ce que Node contient déjà.
 *
 * Le bénéfice de bord n'est pas mince : `Content-Length` est posé exactement,
 * là où `fetch` sur un flux bascule en découpage par blocs que S3 refuse sur
 * une adresse signée.
 */
export type TransportS3 = (
  url: string,
  options: { method: string; headers: Record<string, string>; body?: string; ca?: string | null },
) => Promise<ReponseS3>

/**
 * Délai d'inactivité, et non délai total.
 *
 * `CompleteMultipartUpload` peut tenir la connexion ouverte plusieurs minutes
 * pendant que le stockage recompose un objet de plusieurs gigaoctets — un délai
 * total couperait précisément les gros rushes, c'est-à-dire ceux qui comptent.
 * L'inactivité, elle, ne se déclenche que si plus rien n'arrive : un stockage
 * qui accepte la connexion puis se tait ne doit pas retenir le hub pour la
 * nuit.
 */
const INACTIVITE_MS = 120_000

export const transportNode: TransportS3 = (url, options) =>
  new Promise<ReponseS3>((resoudre, rejeter) => {
    const cible = new URL(url)
    const emettre = cible.protocol === 'https:' ? requeteHttps : requeteHttp
    const corps = options.body == null ? null : Buffer.from(options.body, 'utf8')
    const requete = emettre(
      cible,
      {
        method: options.method,
        headers: {
          ...options.headers,
          ...(corps == null ? {} : { 'content-length': String(corps.byteLength) }),
        },
        ...(options.ca == null ? {} : { ca: options.ca }),
      },
      (reponse) => {
        const morceaux: Buffer[] = []
        reponse.on('data', (bloc: Buffer) => morceaux.push(bloc))
        reponse.on('end', () =>
          resoudre({ status: reponse.statusCode ?? 0, corps: Buffer.concat(morceaux).toString('utf8') }),
        )
      },
    )
    requete.setTimeout(INACTIVITE_MS, () => {
      requete.destroy(
        Object.assign(new Error(`aucune réponse du stockage depuis ${INACTIVITE_MS / 1000} s`), {
          code: 'ETIMEDOUT',
        }),
      )
    })
    requete.on('error', rejeter)
    if (corps != null) requete.write(corps)
    requete.end()
  })

export interface RequeteS3 {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE'
  /** Chemin déjà résolu, encodé, commençant par `/`. */
  path: string
  /** Paramètres de requête, non encodés. Une valeur vide donne un drapeau nu (`?uploads`). */
  query?: Record<string, string>
  headers?: Record<string, string>
  /** Corps déjà sérialisé. Absent = corps vide. */
  body?: string
}

const ALGORITHME = 'AWS4-HMAC-SHA256'
/** Corps non signé : c'est ce que lit un stockage sur une adresse presignée. */
export const CHARGE_NON_SIGNEE = 'UNSIGNED-PAYLOAD'

const sha256 = (valeur: string | Uint8Array): string =>
  createHash('sha256').update(valeur).digest('hex')

const hmac = (cle: Uint8Array | string, message: string): Uint8Array =>
  new Uint8Array(createHmac('sha256', cle).update(message).digest())

/**
 * Encodage RFC 3986, celui qu'exige SigV4.
 *
 * `encodeURIComponent` laisse passer cinq caractères que la norme veut encodés.
 * Les oublier ne casse rien tant qu'aucun titre de conférence ne porte
 * d'apostrophe ou de parenthèses — c'est-à-dire jusqu'au jour où l'un en porte,
 * et où *ce fichier-là* seul refuse de monter.
 */
function encoder(valeur: string): string {
  return encodeURIComponent(valeur).replace(
    /[!'()*]/g,
    (caractere) => `%${caractere.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** Encode un chemin en gardant ses barres : S3 ne double-encode pas le sien. */
export function encoderChemin(chemin: string): string {
  return chemin.split('/').map(encoder).join('/')
}

/** Paramètres triés par nom, chacun encodé. C'est l'ordre qui entre dans la signature. */
function chaineDeRequete(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((nom) => `${encoder(nom)}=${encoder(query[nom] ?? '')}`)
    .join('&')
}

function horodatage(at: Date): { amzDate: string; jour: string } {
  const amzDate = at.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amzDate, jour: amzDate.slice(0, 8) }
}

function cleDeSignature(cles: ClesS3, jour: string): Uint8Array {
  const date = hmac(`AWS4${cles.secretAccessKey}`, jour)
  const region = hmac(date, cles.region)
  const service = hmac(region, 's3')
  return hmac(service, 'aws4_request')
}

interface Canonique {
  requete: string
  entetesSignes: string
}

function canoniser(
  requete: RequeteS3,
  entetes: Record<string, string>,
  empreinteCharge: string,
): Canonique {
  const noms = Object.keys(entetes)
    .map((nom) => nom.toLowerCase())
    .sort()
  const lignes = noms
    .map((nom) => {
      const valeur = entetes[Object.keys(entetes).find((k) => k.toLowerCase() === nom) ?? nom] ?? ''
      return `${nom}:${valeur.trim().replace(/\s+/g, ' ')}\n`
    })
    .join('')
  const entetesSignes = noms.join(';')

  return {
    requete: [
      requete.method,
      requete.path,
      chaineDeRequete(requete.query ?? {}),
      lignes,
      entetesSignes,
      empreinteCharge,
    ].join('\n'),
    entetesSignes,
  }
}

/**
 * Signe une requête par ses en-têtes. C'est la forme des appels que le hub fait
 * lui-même — ouvrir un multipart, le clore, l'abandonner.
 */
export function signerV4(
  cles: ClesS3,
  requete: RequeteS3,
  at: Date = new Date(),
): Record<string, string> {
  const { amzDate, jour } = horodatage(at)
  const empreinteCharge = sha256(requete.body ?? '')
  const hote = new URL(cles.endpoint).host

  const entetes: Record<string, string> = {
    ...requete.headers,
    host: hote,
    'x-amz-content-sha256': empreinteCharge,
    'x-amz-date': amzDate,
  }

  const { requete: canonique, entetesSignes } = canoniser(requete, entetes, empreinteCharge)
  const portee = `${jour}/${cles.region}/s3/aws4_request`
  const aSigner = [ALGORITHME, amzDate, portee, sha256(canonique)].join('\n')
  const signature = Buffer.from(hmac(cleDeSignature(cles, jour), aSigner)).toString('hex')

  return {
    ...entetes,
    authorization:
      `${ALGORITHME} Credential=${cles.accessKeyId}/${portee}, ` +
      `SignedHeaders=${entetesSignes}, Signature=${signature}`,
  }
}

/**
 * Signe une requête dans son adresse, pour que quelqu'un d'autre l'exécute.
 *
 * C'est **toute** la raison d'être de ce module : la salle détient les
 * fichiers, le hub détient les clés, et une adresse presignée est la seule
 * façon de laisser la première écrire chez le stockage sans jamais lui confier
 * les secondes.
 */
export function presigner(
  cles: ClesS3,
  requete: RequeteS3,
  expireDansS: number,
  at: Date = new Date(),
): string {
  const { amzDate, jour } = horodatage(at)
  const hote = new URL(cles.endpoint).host
  const portee = `${jour}/${cles.region}/s3/aws4_request`

  const query: Record<string, string> = {
    ...requete.query,
    'X-Amz-Algorithm': ALGORITHME,
    'X-Amz-Credential': `${cles.accessKeyId}/${portee}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expireDansS),
    'X-Amz-SignedHeaders': 'host',
  }

  const { requete: canonique } = canoniser(
    { ...requete, query },
    { host: hote },
    CHARGE_NON_SIGNEE,
  )
  const aSigner = [ALGORITHME, amzDate, portee, sha256(canonique)].join('\n')
  const signature = Buffer.from(hmac(cleDeSignature(cles, jour), aSigner)).toString('hex')

  const base = new URL(cles.endpoint)
  return `${base.origin}${requete.path}?${chaineDeRequete(query)}&X-Amz-Signature=${signature}`
}

/**
 * Ce que S3 rend quand il refuse.
 *
 * Le `code` est repris tel quel — `SignatureDoesNotMatch`, `NoSuchBucket`,
 * `AccessDenied` — parce que c'est lui qui dit où chercher, et qu'un message
 * traduit ferait perdre le seul mot qu'on puisse mettre dans un moteur de
 * recherche. Il remonte jusqu'à la console.
 */
export class ErreurS3 extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ErreurS3'
  }
}

const balise = (xml: string, nom: string): string | null => {
  const trouve = xml.match(new RegExp(`<${nom}>([\\s\\S]*?)</${nom}>`))
  return trouve?.[1]?.trim() ?? null
}

/**
 * Une réponse S3 en erreur, y compris déguisée en succès.
 *
 * `CompleteMultipartUpload` peut répondre **200 avec une erreur dans le corps** :
 * la requête tient la connexion ouverte pendant que le stockage recompose
 * l'objet, et le statut part avant le verdict. La croire sur son code ferait
 * marquer « terminé » un rush qui n'existe pas.
 */
function verifier(status: number, xml: string): void {
  if (status < 300 && !xml.includes('<Error>')) return
  throw new ErreurS3(
    balise(xml, 'Code') ?? `HTTP ${status}`,
    balise(xml, 'Message') ?? xml.slice(0, 300),
    status,
  )
}

export interface MultipartEnCours {
  key: string
  uploadId: string
  initiatedAt: string | null
}

/** Ce que le hub sait faire d'un bucket. Rien de plus, et c'est voulu. */
export class ClientS3 {
  constructor(
    private readonly cles: ClesS3,
    private readonly bucket: string,
    private readonly transport: TransportS3 = transportNode,
  ) {}

  /** `/bucket/cle`, ou `/cle` quand l'hôte porte déjà le bucket. */
  private chemin(key?: string): string {
    const suffixe = key == null ? '' : `/${encoderChemin(key)}`
    return this.cles.forcePathStyle ? `/${encoder(this.bucket)}${suffixe}` : suffixe || '/'
  }

  private hote(): string {
    const base = new URL(this.cles.endpoint)
    if (this.cles.forcePathStyle) return base.origin
    return `${base.protocol}//${this.bucket}.${base.host}`
  }

  private clesPour(): ClesS3 {
    if (this.cles.forcePathStyle) return this.cles
    return { ...this.cles, endpoint: this.hote() }
  }

  private async appeler(requete: RequeteS3): Promise<string> {
    const cles = this.clesPour()
    const entetes = signerV4(cles, requete)
    const query = chaineDeRequete(requete.query ?? {})
    const url = `${new URL(cles.endpoint).origin}${requete.path}${query ? `?${query}` : ''}`

    const reponse = await this.transport(url, {
      method: requete.method,
      headers: entetes,
      body: requete.body,
      ca: this.cles.caCert ?? null,
    })
    verifier(reponse.status, reponse.corps)
    return reponse.corps
  }

  async creerMultipart(key: string, contentType: string): Promise<string> {
    const xml = await this.appeler({
      method: 'POST',
      path: this.chemin(key),
      query: { uploads: '' },
      headers: { 'content-type': contentType },
    })
    const uploadId = balise(xml, 'UploadId')
    if (uploadId == null) {
      throw new ErreurS3('ReponseIllisible', "le stockage n'a pas rendu d'UploadId", 502)
    }
    return uploadId
  }

  /** Adresse signée pour écrire une part. C'est ce qui descend en salle. */
  presignerPart(key: string, uploadId: string, numero: number, expireDansS: number): string {
    return presigner(
      this.clesPour(),
      {
        method: 'PUT',
        path: this.chemin(key),
        query: { partNumber: String(numero), uploadId },
      },
      expireDansS,
    )
  }

  /** Adresse signée pour écrire un objet entier — le sidecar, quelques kilo-octets. */
  presignerPut(key: string, expireDansS: number): string {
    return presigner(this.clesPour(), { method: 'PUT', path: this.chemin(key) }, expireDansS)
  }

  async terminerMultipart(
    key: string,
    uploadId: string,
    parts: { n: number; etag: string }[],
  ): Promise<void> {
    // L'ordre est celui des numéros de part, pas celui d'arrivée : le stockage
    // recompose dans l'ordre qu'on lui donne, et une salle qui rejoue une part
    // en échec les acquitte forcément dans le désordre.
    const corps =
      '<CompleteMultipartUpload>' +
      [...parts]
        .sort((a, b) => a.n - b.n)
        .map((part) => `<Part><PartNumber>${part.n}</PartNumber><ETag>${part.etag}</ETag></Part>`)
        .join('') +
      '</CompleteMultipartUpload>'

    await this.appeler({
      method: 'POST',
      path: this.chemin(key),
      query: { uploadId },
      headers: { 'content-type': 'application/xml' },
      body: corps,
    })
  }

  async abandonnerMultipart(key: string, uploadId: string): Promise<void> {
    await this.appeler({
      method: 'DELETE',
      path: this.chemin(key),
      query: { uploadId },
    })
  }

  /**
   * Les objets présents sous un préfixe.
   *
   * Ne sert qu'à la remise à zéro de développement : la journée normale n'a
   * jamais besoin de relire ce qu'elle a écrit.
   */
  async listerObjets(prefix: string): Promise<string[]> {
    const cles: string[] = []
    let suite: string | null = null

    // Bornée, comme l'inventaire des multiparts : un stockage qui rendrait des
    // pages indéfiniment ne doit pas retenir le hub.
    for (let page = 0; page < 50; page += 1) {
      const query: Record<string, string> = { 'list-type': '2' }
      if (prefix !== '') query.prefix = prefix
      if (suite != null) query['continuation-token'] = suite

      const xml: string = await this.appeler({ method: 'GET', path: this.chemin(), query })
      for (const bloc of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
        const key = balise(bloc, 'Key')
        if (key != null) cles.push(key)
      }
      if (balise(xml, 'IsTruncated') !== 'true') break
      suite = balise(xml, 'NextContinuationToken')
      if (suite == null) break
    }

    return cles
  }

  /**
   * Supprime un objet.
   *
   * Un par un, et non par lots : `DeleteObjects` exige un en-tête `Content-MD5`
   * que rien d'autre ici ne demande, pour un gain qui ne se mesure qu'au-delà
   * de plusieurs centaines d'objets. Ce geste-ci vide un préfixe de
   * développement, pas un entrepôt.
   */
  async supprimerObjet(key: string): Promise<void> {
    await this.appeler({ method: 'DELETE', path: this.chemin(key) })
  }

  /**
   * Les multiparts ouverts sous un préfixe.
   *
   * Sert au ménage du démarrage, et seulement à lui : c'est la seule façon de
   * retrouver ce qu'un hub a ouvert avant que sa base ne soit recréée. Le
   * registre en base ne sait plus rien de ceux-là, et personne ne les
   * abandonnerait jamais.
   */
  async listerMultiparts(prefix: string): Promise<MultipartEnCours[]> {
    const trouves: MultipartEnCours[] = []
    let keyMarker: string | null = null
    let uploadIdMarker: string | null = null

    // Bornée : un bucket qui rendrait des pages indéfiniment ne doit pas tenir
    // le démarrage du hub en otage un matin d'événement.
    for (let page = 0; page < 20; page += 1) {
      const query: Record<string, string> = { uploads: '' }
      if (prefix !== '') query.prefix = prefix
      if (keyMarker != null) query['key-marker'] = keyMarker
      if (uploadIdMarker != null) query['upload-id-marker'] = uploadIdMarker

      const xml: string = await this.appeler({ method: 'GET', path: this.chemin(), query })

      for (const bloc of xml.match(/<Upload>[\s\S]*?<\/Upload>/g) ?? []) {
        const key = balise(bloc, 'Key')
        const uploadId = balise(bloc, 'UploadId')
        if (key != null && uploadId != null) {
          trouves.push({ key, uploadId, initiatedAt: balise(bloc, 'Initiated') })
        }
      }

      if (balise(xml, 'IsTruncated') !== 'true') break
      keyMarker = balise(xml, 'NextKeyMarker')
      uploadIdMarker = balise(xml, 'NextUploadIdMarker')
      if (keyMarker == null) break
    }

    return trouves
  }
}
