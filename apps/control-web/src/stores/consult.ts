import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useProgramsStore } from './programs.js'

export const CONSULT_TABS = ['program', 'other', 'rooms', 'questions'] as const
export type ConsultTab = (typeof CONSULT_TABS)[number]

/**
 * Consultation: what one goes looking for, never what one drives.
 *
 * A single modal with four tabs rather than four modals, because the operator
 * enters it to answer a question — "how far along is the other room?", "what
 * comes next?" — and changes tab along the way. Four buttons in the header and
 * four modals to close one after another would cost more than they tidy away.
 */
export const useConsultStore = defineStore('consult', () => {
  const open = ref(false)
  const tab = ref<ConsultTab>('program')
  /** The room followed in the "Autre salle" tab, or `null` until one is chosen. */
  const followed = ref<string | null>(null)

  const programs = useProgramsStore()

  function show(which: ConsultTab): void {
    tab.value = which
    open.value = true
  }

  /** Another room's program: loaded on demand, not carried in the state stream. */
  async function follow(roomId: string): Promise<void> {
    followed.value = roomId
    tab.value = 'other'
    open.value = true
    await programs.loadRoom(roomId)
  }

  return { open, tab, followed, show, follow }
})
