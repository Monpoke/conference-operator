import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useSessionStore } from './session.js'

/**
 * Being told about what calls for a gesture.
 *
 * Two families, and they are not set together: **technique** speaks of the
 * machines — a room that no longer answers, a machine to pair — and
 * **exploitation** of the day's run — a slot overrunning, a talk that has not
 * started. Somebody may want to know everything about one and nothing about the
 * other.
 *
 * Three scopes: nothing, the essentials, everything. "essentiel" gathers what
 * calls for a decision; "tout" adds the day's ordinary narrative.
 *
 * The scope and family values are the contract's own: they are not renamed.
 */
export type Scope = 'rien' | 'essentiel' | 'tout'
export type Family = 'technique' | 'exploitation'

export interface Levels {
  technique: Scope
  exploitation: Scope
}

/** This device's setting. The phone in the pocket and the console on the table
 *  are two devices, with two legitimate answers. */
export const LEVELS_KEY = 'hub-notifs'

export const DEFAULT_LEVELS: Levels = { technique: 'essentiel', exploitation: 'essentiel' }

const RANK: Record<Scope, number> = { rien: 0, essentiel: 1, tout: 2 }

/** An alert shown at the bottom of the console, clickable through to its view. */
export interface Alert {
  key: string
  title: string
  body: string
  view: string | null
  scope: Scope
}

/** How long an alert stays on screen. */
export const ALERT_MS = 30_000

export function readLevels(storage: Storage | undefined = globalThis.localStorage): Levels {
  try {
    const raw = JSON.parse(storage?.getItem(LEVELS_KEY) ?? 'null') as unknown
    // The old setting was a plain "1": it means the defaults, rather than silently
    // switching off notifications that were already accepted.
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

/** Does this notice pass this device's setting? */
export function passes(levels: Levels, family: Family, scope: Scope): boolean {
  return RANK[levels[family]] >= RANK[scope]
}

/** A room's state, as the console compares it from one round to the next. */
export interface RoomSeen {
  conference: string
  connectivity: string
}

/**
 * What has changed since the previous round, and deserves saying.
 *
 * A pure, exported function: it is the only part of the system that decides *what*
 * to announce, and the one we want to be able to exercise with no browser.
 *
 * Two keys per room — one for the machine, one for the talk: a "c'est parti" must
 * never come and erase an unread "ne répond plus".
 */
export function roomAlerts(
  before: Map<string, RoomSeen>,
  rooms: { roomId: string; name: string; conference: string; connectivity: string; currentSession?: { title?: string } | null }[],
): { alert: Alert; family: Family }[] {
  // Empty on the first load: announcing six rooms' initial state when the console
  // opens would drown out what actually changes.
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
      // A relief, not a decision: reserved for whoever wants to follow everything.
      push(machine, `${room.name} est revenue`, 'La machine de salle répond de nouveau.', 'technique', 'tout')
    }

    if (room.conference === seen.conference) continue
    const title = room.currentSession?.title
    if (room.conference === 'depassement') {
      // The only one that calls for a decision: it is what shifts the day.
      push(talk, `${room.name} déborde`, 'Le créneau est fini, la conférence est toujours en cours.', 'exploitation', 'essentiel')
    } else if (room.conference === 'retard') {
      push(talk, `${room.name} n'a pas démarré`, "Le créneau a commencé, la conférence n'est pas lancée.", 'exploitation', 'essentiel')
    } else if (room.conference === 'fin-proche') {
      push(talk, `${room.name} · cinq minutes`, 'La conférence touche à sa fin.', 'exploitation', 'tout')
    } else if (room.conference === 'en-cours' && seen.conference === 'pas-commencee') {
      push(talk, `${room.name} · c'est parti`, title ?? 'La conférence a commencé.', 'exploitation', 'tout')
    } else if (room.conference === 'terminee') {
      push(talk, `${room.name} · terminé`, title ?? 'La conférence est terminée.', 'exploitation', 'tout')
    }
  }
  return out
}

export const useNotificationsStore = defineStore('notifications', () => {
  const levels = ref<Levels>(readLevels())
  const alerts = ref<Alert[]>([])
  /** Set once the device is configured: a permission granted elsewhere is not enough. */
  const configured = ref(globalThis.localStorage?.getItem(LEVELS_KEY) != null)

  const seenRooms = new Map<string, RoomSeen>()
  let seenPairings: string | null = null

  const session = useSessionStore()

  const supported = computed(() => typeof Notification !== 'undefined')
  const enabled = computed(() => levels.value.technique !== 'rien' || levels.value.exploitation !== 'rien')
  const on = computed(() => enabled.value && configured.value)

  /** Shows in the page, and only sends to the system if this device asked for it. */
  function raise(alert: Alert, family: Family | null): void {
    // In the page first, and unconditionally: it is the screen one is looking at.
    alerts.value = [...alerts.value.filter((a) => a.key !== alert.key), alert]
    setTimeout(() => dismiss(alert.key), ALERT_MS)

    if (!supported.value || Notification.permission !== 'granted') return
    /*
     * The browser allowing it is not enough: somebody has to have wanted it
     * **here**. A permission granted for another purpose would otherwise make a
     * console nobody configured buzz.
     */
    if (!configured.value) return
    if (family != null && !passes(levels.value, family, alert.scope)) return
    try {
      new Notification(alert.title, { body: alert.body, tag: alert.key, lang: 'fr' })
    } catch {
      // Some mobile browsers refuse the constructor outside a service worker. The
      // console stays usable, and insisting would raise an error every ten seconds.
    }
  }

  function dismiss(key: string): void {
    alerts.value = alerts.value.filter((alert) => alert.key !== key)
  }

  /** Compares the rooms' state with the previous round, and says what changed. */
  function observeRooms(rooms: Parameters<typeof roomAlerts>[1]): void {
    for (const { alert, family } of roomAlerts(seenRooms, rooms)) raise(alert, family)
    for (const room of rooms) {
      seenRooms.set(room.roomId, { conference: room.conference, connectivity: room.connectivity })
    }
  }

  function observePairings(pending: { clientId: string }[]): void {
    const codes = pending.map((request) => request.clientId).sort().join('|')
    if (seenPairings != null && codes !== seenPairings && pending.length > 0) {
      const fresh = pending.filter((request) => !seenPairings!.includes(request.clientId))
      if (fresh.length > 0) {
        raise(
          {
            key: 'appairage',
            title:
              fresh.length === 1
                ? 'Une machine attend son appairage'
                : `${fresh.length} machines attendent leur appairage`,
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
     * A secure context is required: HTTPS, or localhost.
     *
     * Opening the console by the hub's IP address — which is what one naturally
     * does from a phone — is not one, and the failure would arrive further along,
     * under a message about the push service that sends people looking in the wrong
     * place.
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
          // Imposed by the browsers: no silent push, every send must be visible.
          // That is also what we want here.
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBytes(publicKey),
        }))

      const raw = subscription.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } }
      await session.client.rpc.push.subscribe({
        endpoint: raw.endpoint,
        keys: { p256dh: raw.keys.p256dh, auth: raw.keys.auth },
        label: navigator.userAgent.slice(0, 80),
        // Sent again on every change: the filtering of pushed notices happens in
        // the hub, which does not read the browser's local storage.
        levels: levels.value,
      })
      return true
    } catch {
      /*
       * No blocking error: the essential part — being told with the console open —
       * works all the same. Subscribing requires **the browser** to reach its
       * vendor's push service, over the internet; a closed event network refuses
       * that, and it is not a failure of the hub.
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
      // The hub first: forgetting the subscription on the browser side without
      // saying so would leave the hub pushing into the void.
      await session.client.rpc.push.unsubscribe({ endpoint: subscription.endpoint })
      await subscription.unsubscribe()
    } catch {
      // Nothing to make good: the hub purges dead subscriptions by itself.
    }
  }

  /** Saves the setting, and returns what should be said about it to the operator. */
  async function apply(next: Levels): Promise<{ ok: boolean; message: string; offline?: boolean }> {
    levels.value = next

    if (!enabled.value) {
      globalThis.localStorage?.setItem(LEVELS_KEY, JSON.stringify(next))
      configured.value = true
      await unsubscribePush()
      return { ok: true, message: 'Notifications éteintes sur cet appareil' }
    }

    if (supported.value && Notification.permission !== 'granted') {
      // Asked on click, never on load: a browser that sees the question arrive on
      // its own refuses it for good, and it cannot be asked again.
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
 * The VAPID public key arrives as base64url; `subscribe` wants bytes.
 *
 * The buffer is declared `ArrayBuffer` explicitly: `Uint8Array` accepts a
 * `SharedArrayBuffer`, which the subscription API refuses, and the typing reports
 * it rightly rather than letting the failure arrive at run time.
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
