import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session.js'

/**
 * The public page's token, as the console is allowed to see it: whether there is
 * one, its last characters, when the service last reported.
 *
 * The token itself comes back once, from `createToken`, for the operator to copy
 * into the service's secret; the store does not keep it.
 */
export interface MurPublicAccess {
  hasToken: boolean
  tokenHint: string | null
  lastReportAt: string | null
}

export const useMurPublicStore = defineStore('murPublic', () => {
  const status = ref<MurPublicAccess | null>(null)
  const session = useSessionStore()

  async function load(): Promise<void> {
    status.value = (await session.client.rpc.murPublic.status()) as MurPublicAccess
  }

  /** A new token, replacing the old one. Returned once, for the view to show. */
  async function createToken(): Promise<string> {
    const created = (await session.client.rpc.murPublic.createToken()) as { token: string; status: MurPublicAccess }
    status.value = created.status
    return created.token
  }

  async function removeToken(): Promise<void> {
    status.value = (await session.client.rpc.murPublic.removeToken()) as MurPublicAccess
  }

  return { status, load, createToken, removeToken }
})
