import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session.js'

/**
 * Messages waiting to reach a room screen, and the social wall as it is shown.
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

/** A post on the social wall, as the rooms show it. */
export interface ScreenPost extends PendingMessage {
  authorSubtitle: string | null
  avatar: string | null
  image: string | null
  network: string | null
  permalink: string | null
  featured: boolean
  /** Pinned on walls.io: featured whatever the console says. */
  pinned: boolean
  sponsor: { name: string; logo: string | null } | null
}

/** A post written in the console. `id` = the one being edited. */
export interface HubPostDraft {
  id?: string
  author: string
  authorSubtitle: string | null
  avatar: string | null
  text: string
  image: string | null
  network: string | null
  sponsor: { name: string; logo: string | null } | null
  featured: boolean
}

export const useModerationStore = defineStore('moderation', () => {
  const pending = ref<PendingMessage[]>([])
  const screen = ref<ScreenPost[]>([])
  const loading = ref(false)

  const session = useSessionStore()

  async function load(): Promise<void> {
    loading.value = true
    try {
      const [queue, onScreen] = await Promise.all([
        session.client.rpc.wall.pending({}),
        session.client.rpc.wall.onScreen(),
      ])
      pending.value = queue as PendingMessage[]
      screen.value = (onScreen as { posts: ScreenPost[] }).posts
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
   *
   * `reject` on a post already on screen hides it — walls.io's included.
   */
  async function moderate(id: string, decision: 'approve' | 'reject'): Promise<void> {
    await session.client.rpc.wall.moderate({ id, decision })
    await load()
  }

  async function feature(id: string, featured: boolean): Promise<void> {
    await session.client.rpc.wall.feature({ id, featured })
    await load()
  }

  async function savePost(draft: HubPostDraft): Promise<void> {
    await session.client.rpc.wall.save(draft)
    await load()
  }

  return { pending, screen, loading, load, moderate, feature, savePost }
})
