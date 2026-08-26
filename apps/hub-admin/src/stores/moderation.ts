import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session.js'

/**
 * Messages waiting to reach a room screen.
 *
 * One store per resource, not one per view: the operations view and the
 * conferences view would otherwise each keep their own copy of
 * `sessions/states`. Here the resource happens to be used by one view, and the
 * shape is the same anyway.
 */
export interface PendingMessage {
  id: string
  text: string
  author: string
  source: string
  createdAt: string
}

export const useModerationStore = defineStore('moderation', () => {
  const pending = ref<PendingMessage[]>([])
  const loading = ref(false)

  const session = useSessionStore()

  async function load(): Promise<void> {
    loading.value = true
    try {
      pending.value = (await session.client.rpc.wall.pending({})) as PendingMessage[]
    } finally {
      loading.value = false
    }
  }

  /**
   * Approve or reject, then reload.
   *
   * No local removal, deliberately. An action that changes state calls the
   * procedure and re-reads its resource; one source of truth, and the list an
   * operator sees is the list the hub has. The page used to splice the DOM node
   * out, which drifted the moment two operators moderated at once.
   */
  async function moderate(id: string, decision: 'approve' | 'reject'): Promise<void> {
    await session.client.rpc.wall.moderate({ id, decision })
    await load()
  }

  return { pending, loading, load, moderate }
})
