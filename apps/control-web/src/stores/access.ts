import type { Permission } from '@conference-operator/contract'
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { useSessionStore } from './session.js'

/**
 * What the signed-in operator may do from this phone.
 *
 * Remote scope only. Served by the room machine, the control app has full
 * rights over its own room and nobody to ask: this store is never loaded there.
 */
export const useAccessStore = defineStore('access', () => {
  const session = useSessionStore()
  /** `null` until the hub has answered. */
  const permissions = ref<ReadonlySet<string> | null>(null)

  async function load(): Promise<void> {
    try {
      const me = await session.client.rpc.access.me()
      permissions.value = new Set(me.permissions)
    } catch {
      // Already reported by the client's hooks; an expired session signs out.
    }
  }

  watch(
    () => session.signedIn,
    (signedIn) => {
      if (signedIn) void load()
      else permissions.value = null
    },
    { immediate: true },
  )

  function can(permission: Permission): boolean {
    return permissions.value?.has(permission) === true
  }

  return { permissions, load, can }
})
