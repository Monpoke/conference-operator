import { eq } from 'drizzle-orm'
import webpush from 'web-push'
import { hubSetting, pushSubscription } from '@cloudnord/db/hub'
import type { NiveauxNotif } from '@cloudnord/contract'
import type { HubDatabase } from '../db.js'

/**
 * Notifications Web Push des consoles.
 *
 * Ce qui les distingue des notifications de la page : elles arrivent **console
 * fermée**. C'est tout l'intérêt le jour J — la supervision se regarde sur un
 * téléphone rangé dans une poche, pas sur un onglet resté ouvert. En
 * contrepartie, c'est le hub qui doit constater ce qui change, là où la page se
 * contentait de comparer deux rafraîchissements.
 *
 * L'abonnement est propre à un navigateur, pas à un opérateur : la même
 * personne consulte la console sur son téléphone et sur un poste, et n'attend
 * pas la même chose des deux.
 */

/** Clé sous laquelle les clés VAPID sont gardées entre deux démarrages. */
const CLE_VAPID = 'push.vapid'

export interface VapidKeys {
  publicKey: string
  privateKey: string
  /** Contact exigé par la RFC 8292 : les services de push écrivent ici en cas d'abus. */
  subject: string
}

export interface PushPayload {
  title: string
  body: string
  /**
   * Regroupe les avis d'une même salle *et* d'une même famille.
   *
   * Deux étiquettes par salle, pas une : un « Track #2 a commencé » ne doit
   * jamais venir effacer un « Track #2 ne répond plus » resté non lu.
   */
  tag: string
  /** Vue de la console à ouvrir au clic — chaque onglet a son adresse. */
  vue?: string
  famille: FamilleNotif
  /** Niveau minimal auquel cet avis part. */
  niveau: 'essentiel' | 'tout'
}

export type FamilleNotif = 'technique' | 'exploitation'

/** Un abonnement reçoit un avis si son niveau va au moins aussi loin. */
const PORTEE: Record<string, number> = { rien: 0, essentiel: 1, tout: 2 }

export class PushService {
  private readonly keys: VapidKeys | null
  /** Renseigné quand le push est hors service, pour le dire au démarrage. */
  private readonly panne: string | null

  /**
   * @param configured Clés lues dans l'environnement. Absentes, le hub en
   *   fabrique une paire au premier démarrage et la garde : des clés qui
   *   changeraient à chaque redémarrage invalideraient tous les abonnements, et
   *   personne ne se réabonne deux fois.
   */
  constructor(
    private readonly db: HubDatabase,
    configured: Partial<VapidKeys> = {},
  ) {
    const keys = this.resoudreClés(configured)
    try {
      if (keys != null) webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey)
      this.keys = keys
      this.panne = null
    } catch (cause) {
      /**
       * Une clé illisible désactive le push, elle n'arrête pas le hub.
       *
       * C'est un confort de supervision, pas le cœur du système : refuser de
       * démarrer pour ça condamnerait l'événement à cause d'une ligne de
       * `.env`. Le hub le dit fort à l'allumage, et la console ne propose que
       * les notifications de page.
       */
      this.keys = null
      this.panne = `Clés VAPID inutilisables : ${(cause as Error).message}`
    }
  }

  /** `null` quand le push est indisponible : la console ne propose alors rien. */
  publicKey(): string | null {
    return this.keys?.publicKey ?? null
  }

  /** Pourquoi le push est hors service, ou `null` s'il fonctionne. */
  unavailableReason(): string | null {
    return this.panne
  }

  private resoudreClés(configured: Partial<VapidKeys>): VapidKeys | null {
    // Repli local : hors du hub — un test, un script — il n'y a pas de domaine
    // public à annoncer, et la RFC veut un contact quel qu'il soit. Le hub, lui,
    // passe toujours le sien : voir `vapidSubject` dans la config.
    const subject = configured.subject ?? 'mailto:hub@localhost'
    if (configured.publicKey != null && configured.privateKey != null) {
      return { publicKey: configured.publicKey, privateKey: configured.privateKey, subject }
    }

    const row = this.db.select().from(hubSetting).where(eq(hubSetting.key, CLE_VAPID)).get()
    if (row != null) {
      const garde = JSON.parse(row.valueJson) as { publicKey?: string; privateKey?: string }
      if (garde.publicKey != null && garde.privateKey != null) {
        return { publicKey: garde.publicKey, privateKey: garde.privateKey, subject }
      }
    }

    const paire = webpush.generateVAPIDKeys()
    const values = {
      key: CLE_VAPID,
      valueJson: JSON.stringify(paire),
      updatedAt: new Date().toISOString(),
    }
    this.db
      .insert(hubSetting)
      .values(values)
      .onConflictDoUpdate({ target: hubSetting.key, set: values })
      .run()
    return { ...paire, subject }
  }

  subscribe(input: {
    endpoint: string
    p256dh: string
    auth: string
    userId: string | null
    label: string | null
    levels: NiveauxNotif
  }): void {
    const values = {
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userId: input.userId,
      label: input.label,
      niveauTechnique: input.levels.technique,
      niveauExploitation: input.levels.exploitation,
      createdAt: new Date().toISOString(),
      lastPushedAt: null,
    }
    // Le navigateur peut rendre le même endpoint après une réinstallation :
    // écraser vaut mieux qu'un doublon, qui enverrait deux fois chaque avis.
    this.db
      .insert(pushSubscription)
      .values(values)
      .onConflictDoUpdate({ target: pushSubscription.endpoint, set: values })
      .run()
  }

  unsubscribe(endpoint: string): void {
    this.db.delete(pushSubscription).where(eq(pushSubscription.endpoint, endpoint)).run()
  }

  count(): number {
    return this.db.select().from(pushSubscription).all().length
  }

  /**
   * Envoie un avis à toutes les consoles abonnées.
   *
   * Les abonnements morts sont **supprimés à la volée** : un service de push
   * répond 404 ou 410 quand le navigateur a désinstallé la page ou révoqué la
   * permission, et les garder ferait réessayer indéfiniment. Toute autre erreur
   * est passagère — réseau, quota — et l'abonnement reste.
   *
   * @returns Nombre de consoles atteintes.
   */
  async send(payload: PushPayload): Promise<number> {
    if (this.keys == null) return 0
    const attendu = PORTEE[payload.niveau] ?? 1
    const abonnements = this.db
      .select()
      .from(pushSubscription)
      .all()
      // Filtré à l'envoi : un abonnement réglé sur « essentiel » ne doit pas
      // recevoir le rythme de la journée, et un « rien » ne reçoit plus rien
      // sans qu'on ait à supprimer son abonnement — le rallumer ne demande
      // alors pas de repasser par la permission du navigateur.
      .filter((abonnement) => {
        const niveau =
          payload.famille === 'technique'
            ? abonnement.niveauTechnique
            : abonnement.niveauExploitation
        return (PORTEE[niveau] ?? 0) >= attendu
      })
    const corps = JSON.stringify(payload)
    let atteints = 0

    await Promise.all(
      abonnements.map(async (abonnement) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: abonnement.endpoint,
              keys: { p256dh: abonnement.p256dh, auth: abonnement.auth },
            },
            corps,
          )
          atteints += 1
          this.db
            .update(pushSubscription)
            .set({ lastPushedAt: new Date().toISOString() })
            .where(eq(pushSubscription.endpoint, abonnement.endpoint))
            .run()
        } catch (cause) {
          const statut = (cause as { statusCode?: number }).statusCode
          if (statut === 404 || statut === 410) this.unsubscribe(abonnement.endpoint)
        }
      }),
    )
    return atteints
  }
}
