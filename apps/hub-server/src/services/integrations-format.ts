import { createHmac } from 'node:crypto'
import type { IntegrationKind } from '@conference-operator/contract'
import type { PushPayload } from './push.js'

/**
 * What an integration sends: pure functions, so the three formats get tested
 * without a network.
 */

export interface Delivery {
  body: string
  headers: Record<string, string>
}

export interface DeliveryContext {
  /** Hub address, to link the notice to its console view. `null`: no link. */
  publicUrl: string | null
  eventName: string
  deliveryId: string
  sentAt: string
  /** HMAC key of the generic webhook. */
  secret: string | null
}

/**
 * The console address a notice opens.
 *
 * The same mapping as the service worker's `notificationclick`
 * (`pages/service-worker.ts`): a link in a channel and a tap on a notification
 * must land on the same screen.
 */
export function consoleUrl(publicUrl: string | null, view: string | undefined): string | null {
  if (publicUrl == null || view == null) return null
  const path = view === 'exploitation' ? '/admin' : `/admin/${view}`
  return new URL(path, publicUrl).toString()
}

/** Red for what must be looked at, blue for the day's rhythm. */
const emoji = (payload: PushPayload): string => (payload.level === 'essentiel' ? '🔴' : 'ℹ️')

/**
 * Signature of the generic webhook's body: `sha256=<hex>`.
 *
 * Computed over the exact bytes sent — the receiver recomputes it over the raw
 * body before parsing, otherwise a re-serialisation breaks the comparison.
 */
export function signature(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

export function formatDelivery(
  kind: IntegrationKind,
  payload: PushPayload,
  context: DeliveryContext,
): Delivery {
  const url = consoleUrl(context.publicUrl, payload.view)
  const json = { 'content-type': 'application/json' }

  switch (kind) {
    case 'slack': {
      // Slack's mrkdwn: single asterisks, and links as <url|label>.
      const link = url == null ? '' : `\n<${url}|Ouvrir dans la console>`
      return {
        body: JSON.stringify({ text: `${emoji(payload)} *${payload.title}*\n${payload.body}${link}` }),
        headers: json,
      }
    }
    case 'mattermost': {
      // Mattermost reads real Markdown: double asterisks, [label](url).
      const link = url == null ? '' : `\n[Ouvrir dans la console](${url})`
      return {
        body: JSON.stringify({
          text: `${emoji(payload)} **${payload.title}**\n${payload.body}${link}`,
          username: context.eventName,
        }),
        headers: json,
      }
    }
    case 'webhook': {
      const body = JSON.stringify({
        type: 'supervision.notice',
        id: context.deliveryId,
        sentAt: context.sentAt,
        event: { name: context.eventName },
        notice: {
          title: payload.title,
          body: payload.body,
          tag: payload.tag,
          family: payload.family,
          level: payload.level,
          view: payload.view ?? null,
          url,
        },
      })
      return {
        body,
        headers: {
          ...json,
          'x-hub-event': 'supervision.notice',
          'x-hub-delivery': context.deliveryId,
          ...(context.secret == null ? {} : { 'x-hub-signature-256': signature(context.secret, body) }),
        },
      }
    }
  }
}
