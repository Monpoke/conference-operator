import { createReadStream } from 'node:fs'
import { request as requeteHttp } from 'node:http'
import { request as requeteHttps } from 'node:https'
import { and, asc, eq, inArray, ne } from 'drizzle-orm'
import { televersement } from '@cloudnord/db/client'
import type { GenreVod, PartSignee, PlanTeleversement, PolitiqueVod } from '@cloudnord/contract'
import type { LocalStore } from './store.js'
import type { ChargeHote } from './hote.js'
import {
  attenteApres,
  verdictTeleversement,
  type EntreesRegulateur,
  type VerdictTeleversement,
} from './regulateur.js'

/**
 * Rapatriement des rushes, part par part.
 *
 * Deux propriétés portent tout le reste, et elles ont le même but : que le
 * transfert d'un fichier de plusieurs gigaoctets **finisse**, sur un réseau
 * d'événement qui sera coupé.
 *
 * La première est la reprise : l'état vit en base locale, pas en mémoire. Une
 * machine redémarrée repart de la part suivante. Sans elle, une coupure à
 * quatre-vingt-dix pour cent coûte les quatre-vingt-dix pour cent, et une salle
 * qu'on rallume deux fois ne finit jamais.
 *
 * La seconde est qu'on n'en fait qu'un à la fois. Un fichier, une part, une
 * requête. Plusieurs lectures en parallèle sur le disque qui enregistre est
 * exactement ce qu'on ne veut pas — c'est la même raison qui fait que « Tout
 * vérifier » enchaîne les rushes un par un.
 */

/** Ce que la salle sait des fichiers présents sur son disque. */
export interface CandidatVod {
  file: string
  sizeBytes: number
  /** Le fichier a bougé il y a quelques secondes : la prise est peut-être en cours. */
  enEcriture: boolean
  sessionId: string | null
  /** Sidecar existant à côté du rush, ou `null`. */
  sidecar: { file: string; sizeBytes: number } | null
}

/** Le hub, vu du téléverseur. Injecté : le test n'a pas besoin d'un vrai. */
export interface HubVod {
  begin(entree: {
    file: string
    sizeBytes: number
    kind: GenreVod
    sessionId: string | null
  }): Promise<PlanTeleversement>
  parts(uploadId: string, numeros: number[]): Promise<PartSignee[]>
  progress(entree: {
    uploadId: string
    numero: number
    etag: string
    octets: number
    dureeMs: number
  }): Promise<void>
  complete(uploadId: string): Promise<void>
  abort(uploadId: string, raison: string): Promise<void>
}

export interface TeleversementDeps {
  store: LocalStore
  /** Fichiers du disque, dans l'ordre où on souhaite les envoyer. */
  candidats: () => Promise<CandidatVod[]>
  hub: () => HubVod | null
  politique: () => PolitiqueVod | null
  charge: () => ChargeHote
  /** OBS-B enregistre-t-il ? */
  enregistre: () => boolean
  conferenceEnCours: () => boolean
  /** Millisecondes avant la prochaine conférence, sur l'horloge corrigée du hub. */
  msAvantProchaine: () => number | null
  /** Lecture d'une tranche de fichier. Injectée pour tester sans disque. */
  lireTranche?: (file: string, debut: number, fin: number) => Promise<Buffer>
  /** Chemin absolu d'un fichier relatif à la racine des enregistrements. */
  cheminDe: (file: string) => string | null
  /**
   * Autorité de certification du stockage, poussée par le hub. `null` = les
   * CA publiques suffisent.
   */
  caCert?: () => string | null
  envoyerPart?: (url: string, corps: Buffer) => Promise<string>
  attendre?: (ms: number) => Promise<void>
  now?: () => number
  onLog?: (niveau: 'info' | 'warn' | 'error', message: string, contexte?: unknown) => void
}

/** Ce que la régie affiche pour un fichier. */
export interface EtatTeleversementVu {
  file: string
  state: string
  pourcent: number
  debitOctetsS: number | null
  erreur: string | null
  manuel: boolean
}

export interface VueTeleversements {
  entrees: EtatTeleversementVu[]
  verdict: VerdictTeleversement
}

/** Parts signées demandées d'un coup. Assez pour ne pas bavarder, pas assez pour périmer. */
const LOT_DE_PARTS = 5

/** Au-delà, on cesse de rejouer un fichier : quelque chose ne va pas, et il faut le voir. */
const ESSAIS_MAX = 8

export class Televersements {
  private timer: NodeJS.Timeout | null = null
  /**
   * La passe en vol, s'il y en a une.
   *
   * Gardée plutôt qu'un simple drapeau, pour que `passe()` **rejoigne** le
   * travail en cours au lieu de rendre la main tout de suite. Un clic sur
   * « Téléverser » démarre la montée sans l'attendre, mais la boucle de fond,
   * elle, doit pouvoir savoir quand c'est fini — et un test doit pouvoir
   * l'attendre sans deviner combien de temps ça prend.
   */
  private enVol: Promise<void> | null = null
  private dernierVerdict: VerdictTeleversement = {
    autorise: false,
    raison: 'desactive',
    debitMaxOctetsS: null,
    texte: 'aucun stockage configuré sur le hub',
  }
  private echecsDeDebit = 0
  /** Fichier en vol : c'est ce qui garantit qu'on n'en monte qu'un. */
  private actif: string | null = null
  private annules = new Set<string>()

  constructor(private readonly deps: TeleversementDeps) {}

  private get db() {
    return this.deps.store.db
  }

  private get maintenant(): number {
    return (this.deps.now ?? Date.now)()
  }

  private nowIso(): string {
    return new Date(this.maintenant).toISOString()
  }

  /**
   * Met un fichier en file, à la demande d'un humain.
   *
   * `file` nul met tout ce qui reste : c'est le « Tout téléverser » de la régie
   * et le « Tout relancer » de la console. Un fichier déjà terminé n'y revient
   * pas — il est chez le stockage, le remonter ne ferait que payer deux fois.
   */
  async demander(file: string | null): Promise<number> {
    const candidats = await this.deps.candidats()
    const vises = file == null ? candidats : candidats.filter((c) => c.file === file)
    let mis = 0
    for (const candidat of vises) {
      const ligne = this.ligne(candidat.file)
      if (ligne?.state === 'termine') continue
      this.annules.delete(candidat.file)
      this.upsert(candidat, { manuel: true, state: 'attente', nextAttemptAt: this.nowIso() })
      mis += 1
    }
    if (mis > 0) {
      this.deps.onLog?.('info', 'téléversement demandé', { file, fichiers: mis })
      void this.passe()
    }
    return mis
  }

  /**
   * Renonce à un fichier en cours.
   *
   * L'abandon chez le stockage est demandé au hub — lui seul a les clés — mais
   * la ligne locale bascule tout de suite : l'opérateur qui annule doit voir
   * que c'est fait, même si le hub met dix secondes à répondre.
   */
  async annuler(file: string): Promise<void> {
    const ligne = this.ligne(file)
    if (ligne == null || ligne.state === 'termine') return
    this.annules.add(file)
    this.db
      .update(televersement)
      .set({ state: 'abandonne', manuel: false, lastError: 'annulé en régie', finiA: this.nowIso() })
      .where(eq(televersement.file, file))
      .run()

    const hub = this.deps.hub()
    if (hub != null && ligne.s3UploadId != null) {
      await hub.abort(ligne.s3UploadId, 'annulé en régie').catch(() => {})
    }
  }

  vue(): VueTeleversements {
    const lignes = this.db.select().from(televersement).orderBy(asc(televersement.demandeA)).all()
    return {
      verdict: this.dernierVerdict,
      entrees: lignes.map((ligne) => ({
        file: ligne.file,
        state: ligne.state,
        pourcent:
          ligne.tailleOctets > 0
            ? Math.min(100, Math.round((ligne.octetsEnvoyes / ligne.tailleOctets) * 100))
            : 0,
        debitOctetsS: ligne.debitOctetsS,
        erreur: ligne.lastError,
        manuel: ligne.manuel,
      })),
    }
  }

  private ligne(file: string) {
    return this.db.select().from(televersement).where(eq(televersement.file, file)).get()
  }

  private upsert(candidat: CandidatVod, patch: Record<string, unknown>): void {
    const valeurs = {
      file: candidat.file,
      kind: 'rush' as const,
      sessionId: candidat.sessionId,
      tailleOctets: candidat.sizeBytes,
      ...patch,
    }
    this.db
      .insert(televersement)
      .values(valeurs)
      .onConflictDoUpdate({ target: televersement.file, set: patch })
      .run()
  }

  /**
   * Élit le prochain fichier à monter.
   *
   * Les demandes manuelles d'abord, dans l'ordre où elles sont arrivées : c'est
   * l'ordre dans lequel quelqu'un les a cliquées, et le respecter est la seule
   * façon de rendre le geste lisible. Les rushes en cours d'écriture sont
   * écartés — monter une prise qui dure encore produirait un fichier tronqué
   * chez le stockage, et il aurait l'air complet.
   */
  private async elire(): Promise<{ candidat: CandidatVod; manuel: boolean } | null> {
    const candidats = await this.deps.candidats()
    const parFichier = new Map(candidats.map((c) => [c.file, c]))
    const maintenant = this.nowIso()

    const enFile = this.db
      .select()
      .from(televersement)
      .where(and(ne(televersement.state, 'termine'), ne(televersement.state, 'abandonne')))
      .orderBy(asc(televersement.demandeA))
      .all()
      .filter((ligne) => ligne.nextAttemptAt <= maintenant && ligne.attempts < ESSAIS_MAX)

    for (const ligne of [...enFile].sort((a, b) => Number(b.manuel) - Number(a.manuel))) {
      const candidat = parFichier.get(ligne.file)
      if (candidat == null || candidat.enEcriture) continue
      return { candidat, manuel: ligne.manuel }
    }

    if (!(this.deps.politique()?.actif ?? false)) return null

    // Rien en file : on prend le premier rush du disque que personne n'a encore
    // monté. C'est la partie « automatique », et elle ne s'active que si le hub
    // le demande.
    const traites = new Set(
      this.db
        .select({ file: televersement.file })
        .from(televersement)
        .all()
        .map((ligne) => ligne.file),
    )
    const neuf = candidats.find((c) => !c.enEcriture && !traites.has(c.file))
    return neuf == null ? null : { candidat: neuf, manuel: false }
  }

  /**
   * Une passe. Ne lève jamais : c'est une boucle de fond.
   *
   * Elle monte **une seule part** avant de rendre la main. Ce n'est pas une
   * limitation : c'est ce qui rend le plafond de débit applicable, le régulateur
   * réévalué en cours de fichier, et une annulation effective sous quelques
   * secondes plutôt qu'à la fin d'un rush de trois gigaoctets.
   */
  async passe(): Promise<void> {
    // Rejoindre plutôt que d'ignorer : deux passes concurrentes monteraient
    // deux fichiers à la fois sur le disque qui enregistre, ce qui est
    // précisément ce qu'on évite.
    if (this.enVol != null) return this.enVol
    this.enVol = this.uneFois()
      .catch((cause: unknown) => {
        this.deps.onLog?.('warn', 'passe de téléversement en échec', {
          message: (cause as Error).message,
        })
      })
      .finally(() => {
        this.enVol = null
      })
    return this.enVol
  }

  private verdictPour(manuel: boolean): VerdictTeleversement {
    const politique = this.deps.politique()
    const entrees: EntreesRegulateur = {
      stockagePret: politique != null && this.deps.hub() != null,
      politique: politique ?? {
        actif: false,
        debitMaxOctetsS: null,
        cpuMax: 0.7,
        margeConferenceMinutes: 10,
        taillePartMo: 8,
      },
      manuel,
      enregistre: this.deps.enregistre(),
      conferenceEnCours: this.deps.conferenceEnCours(),
      msAvantProchaine: this.deps.msAvantProchaine(),
      charge: this.deps.charge(),
      debitConstateOctetsS: null,
    }
    return verdictTeleversement(entrees)
  }

  private async uneFois(): Promise<void> {
    const elu = await this.elire()
    if (elu == null) {
      // Rien à monter : le verdict affiché est celui d'un automatisme au repos,
      // pas celui d'un refus. Sans quoi la régie dirait « poste chargé » sur une
      // salle qui n'a simplement plus rien à envoyer.
      this.dernierVerdict = this.verdictPour(false)
      return
    }

    const verdict = this.verdictPour(elu.manuel)
    this.dernierVerdict = verdict
    if (!verdict.autorise) {
      if (verdict.raison === 'debit') this.echecsDeDebit += 1
      const dans = attenteApres(verdict.raison ?? 'charge', this.echecsDeDebit)
      this.db
        .update(televersement)
        .set({ nextAttemptAt: new Date(this.maintenant + dans).toISOString() })
        .where(eq(televersement.file, elu.candidat.file))
        .run()
      return
    }

    const hub = this.deps.hub()
    if (hub == null) return

    this.actif = elu.candidat.file
    try {
      await this.monter(hub, elu.candidat, elu.candidat.file, 'rush', elu.candidat.sizeBytes, verdict)
      // Le sidecar suit le rush, jamais l'inverse : un sidecar seul chez le
      // stockage décrirait une conférence dont la vidéo n'est pas arrivée.
      if (elu.candidat.sidecar != null && !this.annules.has(elu.candidat.file)) {
        const ligne = this.ligne(elu.candidat.file)
        if (ligne?.state === 'termine') {
          await this.monterSidecar(hub, elu.candidat)
        }
      }
    } catch (cause) {
      this.echouer(elu.candidat.file, cause as Error)
    } finally {
      this.actif = null
    }
  }

  private echouer(file: string, cause: Error): void {
    const ligne = this.ligne(file)
    const essais = (ligne?.attempts ?? 0) + 1
    // Recul franc : un refus du stockage ne se corrige pas en quinze secondes,
    // et rejouer en boucle masquerait le message dans le journal.
    const dans = Math.min(10 * 60_000, 20_000 * 2 ** Math.min(essais, 5))
    this.db
      .update(televersement)
      .set({
        state: essais >= ESSAIS_MAX ? 'echoue' : 'attente',
        attempts: essais,
        lastError: cause.message.slice(0, 300),
        nextAttemptAt: new Date(this.maintenant + dans).toISOString(),
      })
      .where(eq(televersement.file, file))
      .run()
    this.deps.onLog?.(essais >= ESSAIS_MAX ? 'error' : 'warn', 'téléversement en échec', {
      file,
      essais,
      message: cause.message,
    })
  }

  private async monterSidecar(hub: HubVod, candidat: CandidatVod): Promise<void> {
    const sidecar = candidat.sidecar
    if (sidecar == null) return
    const plan = await hub.begin({
      file: sidecar.file,
      sizeBytes: sidecar.sizeBytes,
      kind: 'sidecar',
      sessionId: candidat.sessionId,
    })
    if (plan.mode !== 'direct') return
    const corps = await this.tranche(sidecar.file, 0, sidecar.sizeBytes)
    await this.envoyer(plan.url, corps)
    await hub.complete(plan.uploadId)
  }

  private async tranche(file: string, debut: number, fin: number): Promise<Buffer> {
    if (this.deps.lireTranche != null) return this.deps.lireTranche(file, debut, fin)
    const chemin = this.deps.cheminDe(file)
    if (chemin == null) throw new Error(`fichier hors de la racine des enregistrements : ${file}`)
    const morceaux: Buffer[] = []
    // `end` est inclusif chez Node : la borne haute est donc `fin - 1`.
    for await (const bloc of createReadStream(chemin, { start: debut, end: fin - 1 })) {
      morceaux.push(bloc as Buffer)
    }
    return Buffer.concat(morceaux)
  }

  private async envoyer(url: string, corps: Buffer): Promise<string> {
    if (this.deps.envoyerPart != null) return this.deps.envoyerPart(url, corps)
    let reponse: { status: number; etag: string | null }
    try {
      reponse = await deposer(url, corps, this.deps.caCert?.() ?? null)
    } catch (cause) {
      /**
       * « fetch failed » ne dit rien, et c'est le seul message qu'undici pose
       * sur *toutes* ses pannes de transport.
       *
       * La vraie cause est rangée dans `cause` : un service éteint
       * (`ECONNREFUSED`), un nom qui ne résout pas (`ENOTFOUND`), un pare-feu
       * qui laisse pendre (`ETIMEDOUT`). Trois pannes qui ne se corrigent pas
       * au même endroit, et la régie n'affichait que la première ligne.
       *
       * L'hôte visé est nommé, sans le reste de l'adresse : une URL presignée
       * porte une signature et des identifiants, et le journal d'une salle se
       * relit à plusieurs.
       */
      throw new Error(
        `Stockage injoignable (${hoteDe(url)}) : ${causeLisible(cause)}`,
        { cause },
      )
    }
    if (reponse.status >= 300) {
      throw new Error(`le stockage a refusé la part (HTTP ${reponse.status})`)
    }
    const etag = reponse.etag
    if (etag == null) {
      // Sans ETag, l'objet ne se recomposera pas : mieux vaut échouer ici, où
      // le message est clair, qu'à la clôture où le stockage dira « InvalidPart ».
      throw new Error("le stockage n'a pas rendu d'ETag pour cette part")
    }
    return etag
  }

  /**
   * Monte un fichier, part par part, en respectant le plafond de débit.
   *
   * Le plafond se tient **entre** les parts, pas dedans : après huit mégaoctets
   * envoyés en deux secondes sous un plafond de deux mégaoctets par seconde, on
   * attend deux secondes. Grain grossier, mais il ne demande ni flux à
   * étrangler ni dépendance — et c'est la taille de part qui le règle, ce qui
   * la rend lisible : un chiffre dans la console, une conséquence visible.
   */
  private async monter(
    hub: HubVod,
    candidat: CandidatVod,
    file: string,
    kind: GenreVod,
    sizeBytes: number,
    verdict: VerdictTeleversement,
  ): Promise<void> {
    const plan = await hub.begin({ file, sizeBytes, kind, sessionId: candidat.sessionId })

    if (plan.mode === 'direct') {
      this.upsert(candidat, {
        state: 'en-cours',
        s3UploadId: plan.uploadId,
        commenceA: this.nowIso(),
        lastError: null,
      })
      const corps = await this.tranche(file, 0, sizeBytes)
      await this.envoyer(plan.url, corps)
      await hub.complete(plan.uploadId)
      this.terminer(file, sizeBytes)
      return
    }

    const dejaLa = new Set(plan.recues)
    this.upsert(candidat, {
      state: 'en-cours',
      s3UploadId: plan.uploadId,
      taillePartOctets: plan.taillePartOctets,
      partsJson: JSON.stringify([...dejaLa]),
      octetsEnvoyes: Math.min(sizeBytes, dejaLa.size * plan.taillePartOctets),
      commenceA: this.nowIso(),
      lastError: null,
    })

    const manquantes: number[] = []
    for (let numero = 1; numero <= plan.parts; numero += 1) {
      if (!dejaLa.has(numero)) manquantes.push(numero)
    }

    const attendre = this.deps.attendre ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

    for (let index = 0; index < manquantes.length; index += LOT_DE_PARTS) {
      if (this.annules.has(file)) return
      const lot = manquantes.slice(index, index + LOT_DE_PARTS)
      const signees = await hub.parts(plan.uploadId, lot)

      for (const part of signees) {
        if (this.annules.has(file)) return
        const debut = (part.numero - 1) * plan.taillePartOctets
        const fin = Math.min(sizeBytes, debut + plan.taillePartOctets)
        const corps = await this.tranche(file, debut, fin)

        const avant = this.maintenant
        const etag = await this.envoyer(part.url, corps)
        const dureeMs = this.maintenant - avant

        await hub.progress({
          uploadId: plan.uploadId,
          numero: part.numero,
          etag,
          octets: corps.byteLength,
          dureeMs,
        })

        dejaLa.add(part.numero)
        const debit = dureeMs > 0 ? Math.round((corps.byteLength * 1000) / dureeMs) : null
        this.db
          .update(televersement)
          .set({
            partsJson: JSON.stringify([...dejaLa].sort((a, b) => a - b)),
            octetsEnvoyes: Math.min(sizeBytes, dejaLa.size * plan.taillePartOctets),
            debitOctetsS: debit,
          })
          .where(eq(televersement.file, file))
          .run()

        const plafond = verdict.debitMaxOctetsS
        if (plafond != null && plafond > 0) {
          const duMoins = (corps.byteLength / plafond) * 1000
          if (duMoins > dureeMs) await attendre(Math.round(duMoins - dureeMs))
        }
      }
    }

    await hub.complete(plan.uploadId)
    this.terminer(file, sizeBytes)
    this.echecsDeDebit = 0
  }

  private terminer(file: string, sizeBytes: number): void {
    this.db
      .update(televersement)
      .set({
        state: 'termine',
        octetsEnvoyes: sizeBytes,
        manuel: false,
        lastError: null,
        finiA: this.nowIso(),
      })
      .where(eq(televersement.file, file))
      .run()
    this.deps.onLog?.('info', 'rush téléversé', { file })
  }

  /**
   * Oublie ce qui n'existe plus sur le disque.
   *
   * Un rush effacé après rapatriement laisserait sinon une ligne éternelle dans
   * la modale de la régie, et « terminé » sur un fichier absent se lit mal.
   */
  async oublierLesDisparus(): Promise<void> {
    const presents = new Set((await this.deps.candidats()).flatMap((c) => [c.file, c.sidecar?.file]))
    const lignes = this.db.select({ file: televersement.file }).from(televersement).all()
    const disparus = lignes.map((l) => l.file).filter((file) => !presents.has(file))
    if (disparus.length > 0) {
      this.db.delete(televersement).where(inArray(televersement.file, disparus)).run()
    }
  }

  /**
   * Oublie toute la file.
   *
   * Accompagne la remise à zéro : garder des lignes « terminé » qui pointent
   * des fichiers effacés ferait dire à la modale que tout est en sécurité.
   */
  oublierTout(): void {
    this.db.delete(televersement).run()
  }

  demarrer(intervalMs = 15_000): void {
    if (this.timer != null) return
    this.timer = setInterval(() => void this.passe(), intervalMs)
    this.timer.unref?.()
  }

  arreter(): void {
    if (this.timer != null) clearInterval(this.timer)
    this.timer = null
  }
}

/**
 * Dépose une part sur une adresse signée.
 *
 * `node:https` plutôt que `fetch`, et pour la même raison que côté hub : `fetch`
 * ne laisse pas ajouter une autorité de certification, et le `Agent` d'undici
 * qui le permettrait n'est pas exposé par Node. Or un stockage interne signé
 * par une CA d'entreprise est exactement le cas où l'on ne veut pas devoir
 * poser une variable d'environnement sur chaque machine de salle.
 *
 * Bénéfice de bord : `Content-Length` est posé exactement, là où `fetch` bascule
 * volontiers en découpage par blocs — que S3 refuse sur une adresse signée.
 */
async function deposer(
  url: string,
  corps: Buffer,
  caCert: string | null,
): Promise<{ status: number; etag: string | null }> {
  return await new Promise((resoudre, rejeter) => {
    const cible = new URL(url)
    const emettre = cible.protocol === 'https:' ? requeteHttps : requeteHttp
    const requete = emettre(
      cible,
      {
        method: 'PUT',
        headers: { 'content-length': String(corps.byteLength) },
        ...(caCert == null ? {} : { ca: caCert }),
      },
      (reponse) => {
        // Le corps ne nous intéresse pas, mais il faut le consommer : un flux
        // laissé en suspens retient la connexion, et la part suivante
        // attendrait un socket qui ne se libère jamais.
        reponse.resume()
        reponse.on('end', () =>
          resoudre({
            status: reponse.statusCode ?? 0,
            etag: (reponse.headers.etag as string | undefined) ?? null,
          }),
        )
      },
    )
    /**
     * Délai d'inactivité, pas délai total.
     *
     * Une part de huit mégaoctets sur un réseau d'événement peut prendre une
     * minute sans que rien n'aille mal. Ce qu'on veut couper, c'est le stockage
     * qui accepte la connexion et se tait — sinon la salle attend jusqu'au
     * démontage.
     */
    requete.setTimeout(120_000, () => {
      requete.destroy(
        Object.assign(new Error('aucune réponse du stockage depuis 120 s'), { code: 'ETIMEDOUT' }),
      )
    })
    requete.on('error', rejeter)
    requete.write(corps)
    requete.end()
  })
}

/** L\'hôte d\'une adresse signée, sans sa signature ni ses identifiants. */
function hoteDe(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'adresse illisible'
  }
}

/**
 * Le vrai motif d'un échec réseau, sous la couche de `fetch`.
 *
 * Même fonction que côté hub, et même raison : le code errno distingue des
 * pannes qui ne se corrigent pas au même endroit, là où « fetch failed » les
 * confond toutes.
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
