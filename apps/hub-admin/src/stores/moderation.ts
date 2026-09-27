import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { CatalogueSponsor } from './boucle.js'
import { useSessionStore } from './session.js'

/**
 * The wall's posts as the console moderates them: a page at a time, searched.
 *
 * One store per resource, not one per view: the operations view and the
 * conferences view would otherwise each keep their own copy of
 * `sessions/states`. Here the resource happens to be used by one view, and the
 * shape is the same anyway.
 */
export type WallView = 'pending' | 'approved' | 'rejected'

/** A post of the wall, with what it did on the room screens. */
export interface WallPost {
  id: string
  text: string
  author: string
  source: string
  status: WallView
  createdAt: string
  authorSubtitle: string | null
  avatar: string | null
  image: string | null
  network: string | null
  permalink: string | null
  featured: boolean
  /** Pinned on walls.io: featured whatever the console says. */
  pinned: boolean
  sponsor: { key: string | null; name: string; logo: string | null } | null
  /** In the social wall the rooms hold right now. */
  onScreen: boolean
  /** Times a room put it on air. */
  impressions: number
  lastShownAt: string | null
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
  sponsor: { key: string | null; name: string; logo: string | null } | null
  featured: boolean
}

export const PAGE_SIZE = 20

export const useModerationStore = defineStore('moderation', () => {
  const view = ref<WallView>('pending')
  const query = ref('')
  const page = ref(1)
  const items = ref<WallPost[]>([])
  const total = ref(0)
  const counts = ref<Record<WallView, number>>({ pending: 0, approved: 0, rejected: 0 })
  const loading = ref(false)
  /** The program's partners a sponsored post can be attached to. */
  const sponsors = ref<CatalogueSponsor[]>([])

  const session = useSessionStore()

  /**
   * Reads the page asked for. The hub answers with the page it could serve — the
   * last one, when a decision emptied the one on screen.
   *
   * Only the latest call writes: a search typed fast sends several, and an older
   * answer arriving last must not replace the newer list.
   */
  let asked = 0
  async function load(): Promise<void> {
    const call = ++asked
    loading.value = true
    try {
      const list = await session.client.rpc.wall.list({
        view: view.value,
        q: query.value,
        page: page.value,
        pageSize: PAGE_SIZE,
      })
      if (call !== asked) return
      items.value = list.items as WallPost[]
      total.value = list.total
      page.value = list.page
      counts.value = list.counts
    } finally {
      if (call === asked) loading.value = false
    }
  }

  async function loadSponsors(): Promise<void> {
    sponsors.value = await session.client.rpc.wall.sponsors()
  }

  async function show(next: WallView): Promise<void> {
    view.value = next
    page.value = 1
    await load()
  }

  async function search(q: string): Promise<void> {
    query.value = q
    page.value = 1
    await load()
  }

  async function goTo(next: number): Promise<void> {
    page.value = Math.max(1, next)
    await load()
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

  return {
    view, query, page, items, total, counts, loading, sponsors,
    load, loadSponsors, show, search, goTo, moderate, feature, savePost,
  }
})
