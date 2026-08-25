import { describe, expect, it, vi } from 'vitest'
import {
  ClientS3,
  encoderChemin,
  presigner,
  signerV4,
  type TransportS3,
} from '../src/services/s3.js'

/**
 * SigV4 écrit à la main : ce test est la seule chose qui prouve qu'il est juste.
 *
 * Une signature fausse ne se manifeste que par un `SignatureDoesNotMatch` sans
 * détail — le stockage ne dit jamais *quoi* diffère, ce serait lui donner de
 * quoi attaquer la clé. Sans vecteurs de référence, on chercherait la panne
 * dans les droits du bucket, l'horloge du serveur ou le mode d'adressage, et le
 * seul moment où on la découvrirait serait le soir de l'événement, un rush à la
 * main.
 *
 * Les valeurs ci-dessous viennent de la documentation d'AWS (« Examples:
 * Signature Calculation for Signature Version 4 »), avec ses identifiants
 * d'exemple. Elles sont figées : c'est ce qui rend le refactoring possible.
 */

const CLES = {
  endpoint: 'https://examplebucket.s3.amazonaws.com',
  region: 'us-east-1',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  forcePathStyle: false,
}

const LE_24_MAI_2013 = new Date('2013-05-24T00:00:00Z')

describe('signature SigV4', () => {
  it('signe par en-têtes comme le vecteur officiel « GET Object »', () => {
    const entetes = signerV4(
      CLES,
      { method: 'GET', path: '/test.txt', headers: { range: 'bytes=0-9' } },
      LE_24_MAI_2013,
    )

    expect(entetes.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    )
    // Le corps vide a bien son empreinte, et non la constante « non signé » :
    // les deux sont valides mais ne produisent pas la même signature.
    expect(entetes['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(entetes['x-amz-date']).toBe('20130524T000000Z')
  })

  it('signe dans l\'adresse comme le vecteur officiel « GET Object presigné »', () => {
    const url = presigner(CLES, { method: 'GET', path: '/test.txt' }, 86_400, LE_24_MAI_2013)

    expect(url).toContain(
      'X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    )
    expect(url).toContain('X-Amz-Expires=86400')
    // Seul `host` est signé sur une adresse presignée : la salle qui l'utilise
    // n'a aucun en-tête à reproduire, et c'est ce qui la rend utilisable telle
    // quelle depuis n'importe quel client HTTP.
    expect(url).toContain('X-Amz-SignedHeaders=host')
  })

  it('encode le chemin en gardant ses barres, et sans oublier les cinq oubliés', () => {
    expect(encoderChemin('2026-10-30/track-1/talk.mkv')).toBe('2026-10-30/track-1/talk.mkv')
    // Un titre de conférence porte volontiers une apostrophe ou des parenthèses.
    // `encodeURIComponent` les laisse passer ; SigV4 les veut encodées, et ce
    // sont exactement ces fichiers-là qui refuseraient de monter, seuls.
    expect(encoderChemin("l'ia (2026).mkv")).toBe('l%27ia%20%282026%29.mkv')
    expect(encoderChemin('a+b&c.mkv')).toBe('a%2Bb%26c.mkv')
  })

  /**
   * Un titre de conférence, tel qu'il arrive dans un nom de fichier.
   *
   * Les signatures ci-dessous ont été **recoupées avec le SDK d'AWS**
   * (`botocore`, `generate_presigned_url`) : caractère pour caractère, la même
   * chaîne. C'est ce qui les rend fiables au-delà des deux vecteurs officiels,
   * qui ne couvrent qu'un `GET /test.txt` — et pas le seul appel qui compte
   * ici, le `PUT` d'une part avec `partNumber` et `uploadId` dans l'adresse.
   *
   * Le cas est choisi pour ce qu'il contient : accents, tilde, plus, pourcent.
   * Ce sont ceux dont l'encodage se discute, et un seul mal encodé ne casse pas
   * le téléversement — il casse *celui-là*, seul, sur un rush au milieu de
   * vingt autres.
   */
  it('signe comme le SDK d\'AWS un nom de fichier qui pique', () => {
    const cles = { ...CLES, endpoint: 'http://localhost:9000', forcePathStyle: true }
    const at = new Date('2026-10-30T11:22:33Z')
    const chemin = `/rushes-cloudnord/${encoderChemin('cn26/2026-10-30/track-1/été~à+100%.mkv')}`

    expect(chemin).toBe('/rushes-cloudnord/cn26/2026-10-30/track-1/%C3%A9t%C3%A9~%C3%A0%2B100%25.mkv')

    // `PUT` d'une part : l'appel qui porte tout le téléversement d'un rush.
    expect(
      presigner(cles, { method: 'PUT', path: chemin, query: { partNumber: '7', uploadId: 'abc~def' } }, 3600, at),
    ).toContain(
      'X-Amz-Signature=34f447dcf04bbd0efacd922f607bcbd69416d3b57b18c5cd93283e19fcaa8536',
    )

    // `PUT` d'objet entier : le sidecar.
    expect(presigner(cles, { method: 'PUT', path: chemin }, 900, at)).toContain(
      'X-Amz-Signature=070892d936f75cfd27c28f95a3d739acf4d847ad37cf0c46ed0e4a35ee9dc137',
    )
  })

  it('trie les paramètres de requête : c\'est l\'ordre qui entre dans la signature', () => {
    const url = presigner(
      CLES,
      { method: 'PUT', path: '/x.mkv', query: { uploadId: 'zz', partNumber: '3' } },
      600,
      LE_24_MAI_2013,
    )
    const params = new URL(url).search.slice(1).split('&').map((p) => p.split('=')[0])
    expect(params.slice(0, -1)).toEqual([...params.slice(0, -1)].sort())
    // La signature se pose en dernier : elle ne se signe pas elle-même.
    expect(params.at(-1)).toBe('X-Amz-Signature')
  })
})

describe('client S3', () => {
  const reponse = (corps: string, status = 200) => ({ status, corps })

  const clesChemin = { ...CLES, endpoint: 'http://localhost:9000', forcePathStyle: true }

  it('ouvre un multipart et rend son identifiant', async () => {
    const faux = vi.fn().mockResolvedValue(
      reponse('<InitiateMultipartUploadResult><UploadId>abc123</UploadId></InitiateMultipartUploadResult>'),
    )
    const client = new ClientS3(clesChemin, 'rushes', faux as unknown as TransportS3)

    expect(await client.creerMultipart('2026/talk.mkv', 'video/x-matroska')).toBe('abc123')
    const [url, init] = faux.mock.calls[0] as [string, { method: string }]
    // Adressage par chemin : c'est le seul mode qui marche sur une adresse IP,
    // donc sur le MinIO d'un développeur comme sur un stockage d'hébergeur.
    expect(url).toBe('http://localhost:9000/rushes/2026/talk.mkv?uploads=')
    expect(init.method).toBe('POST')
  })

  it('recompose l\'objet dans l\'ordre des parts, pas dans celui de leur arrivée', async () => {
    const faux = vi.fn().mockResolvedValue(reponse('<CompleteMultipartUploadResult/>'))
    const client = new ClientS3(clesChemin, 'rushes', faux as unknown as TransportS3)

    // Une part rejouée après échec s'acquitte forcément dans le désordre.
    await client.terminerMultipart('talk.mkv', 'u1', [
      { n: 3, etag: '"c"' },
      { n: 1, etag: '"a"' },
      { n: 2, etag: '"b"' },
    ])

    const corps = (faux.mock.calls[0]?.[1] as { body: string }).body
    expect(corps.indexOf('"a"')).toBeLessThan(corps.indexOf('"b"'))
    expect(corps.indexOf('"b"')).toBeLessThan(corps.indexOf('"c"'))
  })

  it('refuse une clôture qui répond 200 avec une erreur dans le corps', async () => {
    // Le cas piège de `CompleteMultipartUpload` : la connexion reste ouverte
    // pendant que le stockage recompose, et le statut part avant le verdict.
    // Croire le code ferait marquer « terminé » un rush qui n'existe pas.
    const faux = vi.fn(async () =>
      reponse('<Error><Code>InvalidPart</Code><Message>part 2 introuvable</Message></Error>', 200),
    )
    const client = new ClientS3(clesChemin, 'rushes', faux as unknown as TransportS3)

    await expect(
      client.terminerMultipart('talk.mkv', 'u1', [{ n: 1, etag: '"a"' }]),
    ).rejects.toMatchObject({ code: 'InvalidPart', message: 'part 2 introuvable' })
  })

  it('rend le code du stockage tel quel : c\'est lui qui dit où chercher', async () => {
    const faux = vi.fn().mockResolvedValue(
      reponse('<Error><Code>SignatureDoesNotMatch</Code><Message>nope</Message></Error>', 403),
    )
    const client = new ClientS3(clesChemin, 'rushes', faux as unknown as TransportS3)

    await expect(client.creerMultipart('x.mkv', 'video/x-matroska')).rejects.toMatchObject({
      code: 'SignatureDoesNotMatch',
      status: 403,
    })
  })

  it('déroule la pagination des multiparts ouverts', async () => {
    const faux = vi
      .fn()
      .mockResolvedValueOnce(
        reponse(
          '<ListMultipartUploadsResult><IsTruncated>true</IsTruncated>' +
            '<NextKeyMarker>a.mkv</NextKeyMarker><NextUploadIdMarker>u1</NextUploadIdMarker>' +
            '<Upload><Key>a.mkv</Key><UploadId>u1</UploadId><Initiated>2026-10-30T09:00:00.000Z</Initiated></Upload>' +
            '</ListMultipartUploadsResult>',
        ),
      )
      .mockResolvedValueOnce(
        reponse(
          '<ListMultipartUploadsResult><IsTruncated>false</IsTruncated>' +
            '<Upload><Key>b.mkv</Key><UploadId>u2</UploadId></Upload>' +
            '</ListMultipartUploadsResult>',
        ),
      )
    const client = new ClientS3(clesChemin, 'rushes', faux as unknown as TransportS3)

    const trouves = await client.listerMultiparts('cn26/')
    expect(trouves.map((m) => m.uploadId)).toEqual(['u1', 'u2'])
    expect(trouves[0]?.initiatedAt).toBe('2026-10-30T09:00:00.000Z')
    // Sans date d'ouverture, le ménage ne l'abandonnera pas : mieux vaut laisser
    // traîner un multipart que d'en supprimer un qu'une salle est en train
    // d'alimenter.
    expect(trouves[1]?.initiatedAt).toBeNull()
  })
})
