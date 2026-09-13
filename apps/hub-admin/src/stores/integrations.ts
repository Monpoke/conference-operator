import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session.js'

/**
 * Where the supervision notices go besides the consoles: Slack, Mattermost, a
 * webhook.
 *
 * The hub never gives an address back whole — it is a credential. The store
 * therefore holds what the hub shows, and an edit only sends what was retyped.
 */
export type IntegrationKind = 'slack' | 'mattermost' | 'webhook'
export type Level = 'rien' | 'essentiel' | 'tout'

export interface Integration {
  id: string
  kind: IntegrationKind
  name: string
  enabled: boolean
  /** Masked by the hub. */
  url: string
  hasSecret: boolean
  levels: { technique: Level; exploitation: Level }
  createdAt: string
  lastSentAt: string | null
  lastErrorAt: string | null
  lastError: string | null
}

export interface IntegrationDraft {
  kind: IntegrationKind
  name: string
  url: string
  secret: string | null
  levels: { technique: Level; exploitation: Level }
  enabled: boolean
}

/** Absent fields stay as the hub holds them; `secret: null` removes it. */
export interface IntegrationPatch {
  id: string
  name?: string
  url?: string
  secret?: string | null
  levels?: { technique: Level; exploitation: Level }
  enabled?: boolean
}

export interface IntegrationTestResult {
  ok: boolean
  status: number | null
  error: string | null
}

export const KIND_LABELS: Record<IntegrationKind, string> = {
  slack: 'Slack',
  mattermost: 'Mattermost',
  webhook: 'Webhook JSON',
}

export const useIntegrationsStore = defineStore('integrations', () => {
  const integrations = ref<Integration[]>([])
  const session = useSessionStore()

  async function load(): Promise<void> {
    integrations.value = (await session.client.rpc.integrations.list()) as Integration[]
  }

  async function create(draft: IntegrationDraft): Promise<void> {
    await session.client.rpc.integrations.create(draft)
    await load()
  }

  async function update(patch: IntegrationPatch): Promise<void> {
    await session.client.rpc.integrations.update(patch)
    await load()
  }

  async function remove(id: string): Promise<void> {
    await session.client.rpc.integrations.remove({ id })
    await load()
  }

  /** Reloads afterwards: the test's outcome is the integration's last status. */
  async function test(id: string): Promise<IntegrationTestResult> {
    const result = (await session.client.rpc.integrations.test({ id })) as IntegrationTestResult
    await load()
    return result
  }

  return { integrations, load, create, update, remove, test }
})

const clock = (iso: string): string =>
  new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

/**
 * The last thing that happened, success or failure — whichever is more recent.
 *
 * A failure an hour old followed by ten successes is no longer news; a failure
 * after the last success is exactly what the operator came to see.
 */
export function deliveryStatus(item: Integration): { ok: boolean; text: string } | null {
  if (item.lastErrorAt != null && (item.lastSentAt == null || item.lastErrorAt > item.lastSentAt)) {
    return { ok: false, text: `Échec le ${clock(item.lastErrorAt)} — ${item.lastError ?? 'erreur inconnue'}` }
  }
  if (item.lastSentAt != null) return { ok: true, text: `Dernier envoi le ${clock(item.lastSentAt)}` }
  return null
}
