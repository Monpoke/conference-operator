import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session.js'

/**
 * The walls.io link, as the console is allowed to see it.
 *
 * No token, ever — `hasToken` and its last four characters are the whole of
 * what comes back. The field it is typed in is emptied once sent.
 */
export interface WallsIoStatus {
  hasToken: boolean
  tokenHint: string | null
  lastPollAt: string | null
  lastError: string | null
  imported: number
}

export const useWallsIoStore = defineStore('wallsio', () => {
  const status = ref<WallsIoStatus | null>(null)
  const session = useSessionStore()

  async function load(): Promise<void> {
    status.value = (await session.client.rpc.wallsio.status()) as WallsIoStatus
  }

  /** `null` removes it. The hub polls straight away: the answer says whether it works. */
  async function setToken(token: string | null): Promise<WallsIoStatus> {
    status.value = (await session.client.rpc.wallsio.setToken({ token })) as WallsIoStatus
    return status.value
  }

  return { status, load, setToken }
})
