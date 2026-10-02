import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session.js'

/**
 * The public wall and the questions, on or off — for the views that link to them.
 *
 * Read from `event.identity`, which every operator may read: the room cards and
 * the banner templates must drop a dead link without asking for `settings:read`.
 * "On" until read: a link that shows a second too long beats one that never shows.
 */
export const useFeaturesStore = defineStore('features', () => {
  const wall = ref(true)
  const questions = ref(true)
  const session = useSessionStore()

  async function load(): Promise<void> {
    try {
      const identity = (await session.client.rpc.event.identity()) as {
        features?: { wall: boolean; questions: boolean }
      }
      wall.value = identity.features?.wall ?? true
      questions.value = identity.features?.questions ?? true
    } catch {
      // An older hub, or no `program:read`: the links stay, as they always did.
    }
  }

  return { wall, questions, load }
})
