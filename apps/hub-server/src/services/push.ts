import { eq } from 'drizzle-orm'
import webpush from 'web-push'
import { hubSetting, pushSubscription } from '@cloudnord/db/hub'
import type { NotifLevels } from '@cloudnord/contract'
import type { HubDatabase } from '../db.js'

/**
 * Web Push notifications for the consoles.
 *
 * What sets them apart from the page's notifications: they arrive with the
 * **console closed**. That is the whole point on the day — supervision gets
 * watched on a phone tucked in a pocket, not on a tab left open. In exchange, it
 * is the hub that has to observe what changes, where the page merely compared two
 * refreshes.
 *
 * A subscription belongs to a browser, not to an operator: the same person
 * watches the console on their phone and on a machine, and does not expect the
 * same thing from both.
 */

/** Key under which the VAPID keys are kept between two startups. */
const VAPID_SETTING_KEY = 'push.vapid'

export interface VapidKeys {
  publicKey: string
  privateKey: string
  /** Contact required by RFC 8292: push services write here in case of abuse. */
  subject: string
}

export interface PushPayload {
  title: string
  body: string
  /**
   * Groups the notices of one room *and* one family.
   *
   * Two tags per room, not one: a "Track #2 has started" must never wipe out an
   * unread "Track #2 is not answering".
   */
  tag: string
  /** Console view to open on click — every tab has its address. */
  view?: string
  family: NotifFamily
  /** Minimum level at which this notice goes out. */
  level: 'essentiel' | 'tout'
}

export type NotifFamily = 'technique' | 'exploitation'

/** A subscription receives a notice if its level reaches at least as far. */
const REACH: Record<string, number> = { rien: 0, essentiel: 1, tout: 2 }

export class PushService {
  private readonly keys: VapidKeys | null
  /** Set when push is out of service, so it can be said at startup. */
  private readonly failure: string | null

  /**
   * @param configured Keys read from the environment. Absent, the hub generates
   *   a pair at the first startup and keeps it: keys that changed on every
   *   restart would invalidate every subscription, and nobody subscribes twice.
   */
  constructor(
    private readonly db: HubDatabase,
    configured: Partial<VapidKeys> = {},
  ) {
    const keys = this.resolveKeys(configured)
    try {
      if (keys != null) webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey)
      this.keys = keys
      this.failure = null
    } catch (cause) {
      /**
       * An unreadable key disables push, it does not stop the hub.
       *
       * It is a supervision convenience, not the core of the system: refusing to
       * start over it would doom the event because of one line of `.env`. The hub
       * says so loudly at switch-on, and the console only offers page
       * notifications.
       */
      this.keys = null
      this.failure = `Clés VAPID inutilisables : ${(cause as Error).message}`
    }
  }

  /** `null` when push is unavailable: the console then offers nothing. */
  publicKey(): string | null {
    return this.keys?.publicKey ?? null
  }

  /** Why push is out of service, or `null` if it works. */
  unavailableReason(): string | null {
    return this.failure
  }

  private resolveKeys(configured: Partial<VapidKeys>): VapidKeys | null {
    // Local fallback: outside the hub — a test, a script — there is no public
    // domain to announce, and the RFC wants a contact, whatever it is. The hub
    // always passes its own: see `vapidSubject` in the config.
    const subject = configured.subject ?? 'mailto:hub@localhost'
    if (configured.publicKey != null && configured.privateKey != null) {
      return { publicKey: configured.publicKey, privateKey: configured.privateKey, subject }
    }

    const row = this.db.select().from(hubSetting).where(eq(hubSetting.key, VAPID_SETTING_KEY)).get()
    if (row != null) {
      const kept = JSON.parse(row.valueJson) as { publicKey?: string; privateKey?: string }
      if (kept.publicKey != null && kept.privateKey != null) {
        return { publicKey: kept.publicKey, privateKey: kept.privateKey, subject }
      }
    }

    const pair = webpush.generateVAPIDKeys()
    const values = {
      key: VAPID_SETTING_KEY,
      valueJson: JSON.stringify(pair),
      updatedAt: new Date().toISOString(),
    }
    this.db
      .insert(hubSetting)
      .values(values)
      .onConflictDoUpdate({ target: hubSetting.key, set: values })
      .run()
    return { ...pair, subject }
  }

  subscribe(input: {
    endpoint: string
    p256dh: string
    auth: string
    userId: string | null
    label: string | null
    levels: NotifLevels
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
    // The browser can return the same endpoint after a reinstall: overwriting
    // beats a duplicate, which would send every notice twice.
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
   * Sends a notice to every subscribed console.
   *
   * Dead subscriptions are **deleted on the fly**: a push service answers 404 or
   * 410 when the browser has uninstalled the page or revoked the permission, and
   * keeping them would retry indefinitely. Any other error is transient —
   * network, quota — and the subscription stays.
   *
   * @returns Number of consoles reached.
   */
  async send(payload: PushPayload): Promise<number> {
    if (this.keys == null) return 0
    const wanted = REACH[payload.level] ?? 1
    const subscriptions = this.db
      .select()
      .from(pushSubscription)
      .all()
      // Filtered at send time: a subscription set to "essentiel" must not receive
      // the rhythm of the day, and a "rien" receives nothing without having to
      // delete its subscription — turning it back on then does not require going
      // through the browser's permission again.
      .filter((subscription) => {
        const level =
          payload.family === 'technique'
            ? subscription.niveauTechnique
            : subscription.niveauExploitation
        return (REACH[level] ?? 0) >= wanted
      })
    const body = JSON.stringify(payload)
    let reached = 0

    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            body,
          )
          reached += 1
          this.db
            .update(pushSubscription)
            .set({ lastPushedAt: new Date().toISOString() })
            .where(eq(pushSubscription.endpoint, subscription.endpoint))
            .run()
        } catch (cause) {
          const status = (cause as { statusCode?: number }).statusCode
          if (status === 404 || status === 410) this.unsubscribe(subscription.endpoint)
        }
      }),
    )
    return reached
  }
}
