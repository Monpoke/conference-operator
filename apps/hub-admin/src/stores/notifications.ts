import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useSessionStore } from './session.js'

/**
 * Être prévenu de ce qui appelle un geste.
 *
 * Deux familles, et elles ne se règlent pas ensemble : **technique** parle des
 * machines — une salle qui ne répond plus, une machine à appairer — et
 * **exploitation** du déroulé — un créneau qui déborde, une conférence qui
 * n'a pas démarré. Quelqu'un peut vouloir tout savoir des unes et rien des
 * autres.
 *
 * Trois portées : rien, l'essentiel, tout. « Essentiel » réunit ce qui demande
 * un arbitrage ; « tout » ajoute le récit ordinaire de la journée.
 */
export type Scope = 'rien' | 'essentiel' | 'tout'
export type Family = 'technique' | 'exploitation'

export interface Levels {
  technique: Scope
  exploitation: Scope
}

/** Le réglage de cet appareil-ci. Le téléphone dans la poche et la console
 *  posée sur la table sont deux appareils, avec deux réponses légitimes. */
export const LEVELS_KEY = 'hub-notifs'

export const DEFAULT_LEVELS: Levels = { technique: 'essentiel', exploitation: 'essentiel' }

const RANK: Record<Scope, number> = { rien: 0, essentiel: 1, tout: 2 }

/** Une alerte affichée en bas de la console, et cliquable vers sa vue. */
export interface Alert {
  key: string
  title: string
  body: string
  view: string | null
  scope: Scope
}

/** Combien de temps une alerte reste à l'écran. */
export const ALERT_MS = 30_000

export function readLevels(storage: Storage | undefined = globalThis.localStorage): Levels {
  try {
    const raw = JSON.parse(storage?.getItem(LEVELS_KEY) ?? 'null') as unknown
    // L'ancien réglage était un simple « 1 » : il vaut les défauts, plutôt que
    // d'éteindre en silence des notifications déjà acceptées.
    if (raw === '1' || raw == null) return { ...DEFAULT_LEVELS }
    const shape = raw as Partial<Levels>
    return {
      technique: shape.technique ?? DEFAULT_LEVELS.technique,
      exploitation: shape.exploitation ?? DEFAULT_LEVELS.exploitation,
    }
  } catch {
    return { ...DEFAULT_LEVELS }
  }
}

/** Cet avis-là passe-t-il le réglage de cet appareil ? */
export function passes(levels: Levels, family: Family, scope: Scope): boolean {
  return RANK[levels[family]] >= RANK[scope]
}

/** État d'une salle, tel que la console le compare d'un tour à l'autre. */
export interface RoomSeen {
  conference: string
  connectivity: string
}

/**
 * Ce qui a changé depuis le tour précédent, et mérite d'être dit.
 *
 * Fonction pure et exportée : c'est la seule partie du système qui décide
 * *quoi* annoncer, et c'est celle qu'on veut pouvoir éprouver sans navigateur.
 *
 * Deux clés par salle — une pour la machine, une pour la conférence : un
 * « c'est parti » ne doit jamais venir effacer un « ne répond plus » resté non
 * lu.
 */
export function roomAlerts(
  before: Map<string, RoomSeen>,
  rooms: { roomId: string; name: string; conference: string; connectivity: string; currentSession?: { title?: string } | null }[],
): { alert: Alert; family: Family }[] {
  // Vide au premier chargement : annoncer l'état initial de six salles à
  // l'ouverture de la console noierait ce qui change vraiment.
  if (before.size === 0) return []

  const out: { alert: Alert; family: Family }[] = []
  for (const room of rooms) {
    const seen = before.get(room.roomId)
    if (seen == null) continue

    const machine = `salle-${room.roomId}`
    const talk = `conf-${room.roomId}`
    const push = (key: string, title: string, body: string, family: Family, scope: Scope): void => {
      out.push({ alert: { key, title, body, view: 'exploitation', scope }, family })
    }

    if (room.connectivity !== 'ONLINE' && seen.connectivity === 'ONLINE') {
      push(machine, `${room.name} ne répond plus`, 'Plus de nouvelles de la machine de salle.', 'technique', 'essentiel')
    } else if (room.connectivity === 'ONLINE' && seen.connectivity !== 'ONLINE') {
      // Un soulagement, pas une décision : réservé à qui veut tout suivre.
      push(machine, `${room.name} est revenue`, 'La machine de salle répond de nouveau.', 'technique', 'tout')
    }

    if (room.conference === seen.conference) continue
    const titre = room.currentSession?.title
    if (room.conference === 'depassement') {
      // Le seul qui demande un arbitrage : c'est lui qui décale la journée.
      push(talk, `${room.name} déborde`, 'Le créneau est fini, la conférence est toujours en cours.', 'exploitation', 'essentiel')
    } else if (room.conference === 'retard') {
      push(talk, `${room.name} n'a pas démarré`, "Le créneau a commencé, la conférence n'est pas lancée.", 'exploitation', 'essentiel')
    } else if (room.conference === 'fin-proche') {
      push(talk, `${room.name} · cinq minutes`, 'La conférence touche à sa fin.', 'exploitation', 'tout')
    } else if (room.conference === 'en-cours' && seen.conference === 'pas-commencee') {
      push(talk, `${room.name} · c'est parti`, titre ?? 'La conférence a commencé.', 'exploitation', 'tout')
    } else if (room.conference === 'terminee') {
      push(talk, `${room.name} · terminé`, titre ?? 'La conférence est terminée.', 'exploitation', 'tout')
    }
  }
  return out
}

export const useNotificationsStore = defineStore('notifications', () => {
  const levels = ref<Levels>(readLevels())
  const alerts = ref<Alert[]>([])
  /** Posé une fois l'appareil réglé : une permission accordée ailleurs ne suffit pas. */
  const configured = ref(globalThis.localStorage?.getItem(LEVELS_KEY) != null)

  const seenRooms = new Map<string, RoomSeen>()
  let seenPairings: string | null = null

  const session = useSessionStore()

  const supported = computed(() => typeof Notification !== 'undefined')
  const enabled = computed(() => levels.value.technique !== 'rien' || levels.value.exploitation !== 'rien')
  const on = computed(() => enabled.value && configured.value)

  /** Affiche en page, et n'envoie au système que si cet appareil l'a voulu. */
  function raise(alert: Alert, family: Family | null): void {
    // En page d'abord, et sans condition : c'est l'écran qu'on regarde.
    alerts.value = [...alerts.value.filter((a) => a.key !== alert.key), alert]
    setTimeout(() => dismiss(alert.key), ALERT_MS)

    if (!supported.value || Notification.permission !== 'granted') return
    /*
     * Il ne suffit pas que le navigateur allowed : il faut que quelqu'un l'ait
     * voulu **ici**. Une permission accordée pour un autre usage ferait sinon
     * vibrer une console que personne n'a réglée.
     */
    if (!configured.value) return
    if (family != null && !passes(levels.value, family, alert.scope)) return
    try {
      new Notification(alert.title, { body: alert.body, tag: alert.key, lang: 'fr' })
    } catch {
      // Certains navigateurs mobiles refusent le constructeur hors service
      // worker. La console reste utilisable, et insister ferait une erreur
      // toutes les dix secondes.
    }
  }

  function dismiss(key: string): void {
    alerts.value = alerts.value.filter((alert) => alert.key !== key)
  }

  /** Compare l'état des salles au tour précédent, et dit ce qui a changé. */
  function observeRooms(rooms: Parameters<typeof roomAlerts>[1]): void {
    for (const { alert, family } of roomAlerts(seenRooms, rooms)) raise(alert, family)
    for (const room of rooms) {
      seenRooms.set(room.roomId, { conference: room.conference, connectivity: room.connectivity })
    }
  }

  function observePairings(pending: { clientId: string }[]): void {
    const codes = pending.map((demande) => demande.clientId).sort().join('|')
    if (seenPairings != null && codes !== seenPairings && pending.length > 0) {
      const nouvelles = pending.filter((demande) => !seenPairings!.includes(demande.clientId))
      if (nouvelles.length > 0) {
        raise(
          {
            key: 'appairage',
            title:
              nouvelles.length === 1
                ? 'Une machine attend son appairage'
                : `${nouvelles.length} machines attendent leur appairage`,
            body: "Le code est affiché sur l'écran de régie.",
            view: 'appairage',
            scope: 'essentiel',
          },
          'technique',
        )
      }
    }
    seenPairings = codes
  }

  async function subscribePush(): Promise<boolean> {
    if (!('serviceWorker' in navigator) || !('PushManager' in globalThis)) return false
    /*
     * Contexte sécurisé exigé : HTTPS, ou localhost.
     *
     * Ouvrir la console par l'adresse IP du hub — ce qu'on fait naturellement
     * depuis un téléphone — n'en est pas un, et l'échec arriverait plus loin,
     * sous un message qui parle de service de push et envoie chercher au
     * mauvais endroit.
     */
    if (!globalThis.isSecureContext) return false
    try {
      const { publicKey } = (await session.client.rpc.push.publicKey()) as { publicKey?: string }
      if (publicKey == null || publicKey === '') return false

      const worker = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready
      const subscription =
        (await worker.pushManager.getSubscription()) ??
        (await worker.pushManager.subscribe({
          // Imposé par les navigateurs : pas de push silencieux, chaque envoi
          // doit se voir. C'est aussi ce qu'on veut ici.
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBytes(publicKey),
        }))

      const raw = subscription.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } }
      await session.client.rpc.push.subscribe({
        endpoint: raw.endpoint,
        keys: { p256dh: raw.keys.p256dh, auth: raw.keys.auth },
        label: navigator.userAgent.slice(0, 80),
        // Renvoyés à chaque changement : le filtrage des avis poussés se fait
        // dans le hub, qui ne lit pas le stockage local du navigateur.
        levels: levels.value,
      })
      return true
    } catch {
      /*
       * Pas d'erreur bloquante : l'essentiel — être prévenu console ouverte —
       * fonctionne quand même. S'abonner exige que **le navigateur** joigne le
       * service de push de son éditeur, sur Internet ; un réseau d'événement
       * fermé le refuse, et ce n'est pas une panne du hub.
       */
      return false
    }
  }

  async function unsubscribePush(): Promise<void> {
    if (!('serviceWorker' in navigator)) return
    try {
      const worker = await navigator.serviceWorker.getRegistration()
      const subscription = await worker?.pushManager.getSubscription()
      if (subscription == null) return
      // Le hub d'abord : oublier l'abonnement côté navigateur sans le dire
      // laisserait le hub pousser dans le vide.
      await session.client.rpc.push.unsubscribe({ endpoint: subscription.endpoint })
      await subscription.unsubscribe()
    } catch {
      // Rien à rattraper : le hub purge de lui-même les abonnements morts.
    }
  }

  /** Enregistre le réglage, et retourne ce qu'il faut en dire à l'opérateur. */
  async function apply(next: Levels): Promise<{ ok: boolean; message: string; offline?: boolean }> {
    levels.value = next

    if (!enabled.value) {
      globalThis.localStorage?.setItem(LEVELS_KEY, JSON.stringify(next))
      configured.value = true
      await unsubscribePush()
      return { ok: true, message: 'Notifications éteintes sur cet appareil' }
    }

    if (supported.value && Notification.permission !== 'granted') {
      // Demandée au clic, jamais au chargement : un navigateur qui voit la
      // question arriver seule la refuse pour de bon, et on ne la repose plus.
      const answer = await Notification.requestPermission()
      if (answer !== 'granted') {
        return {
          ok: false,
          message:
            answer === 'denied'
              ? 'Notifications refusées par le navigateur : à rouvrir dans ses réglages de site'
              : 'Notifications non activées',
        }
      }
    }

    globalThis.localStorage?.setItem(LEVELS_KEY, JSON.stringify(next))
    configured.value = true
    const offline = await subscribePush()
    return { ok: true, message: 'Notifications activées', offline }
  }

  return {
    levels,
    alerts,
    configured,
    supported,
    enabled,
    on,
    raise,
    dismiss,
    observeRooms,
    observePairings,
    apply,
  }
})

/**
 * La clé publique VAPID arrive en base64url ; `subscribe` veut des octets.
 *
 * Le tampon est déclaré `ArrayBuffer` explicitement : `Uint8Array` accepte un
 * `SharedArrayBuffer`, que l'API de souscription refuse, et le typage le
 * signale à raison plutôt que de laisser l'échec arriver à l'exécution.
 */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = (value + '='.repeat((4 - (value.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  const raw = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index)
  return bytes
}
