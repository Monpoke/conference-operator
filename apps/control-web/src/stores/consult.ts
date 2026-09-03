import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useProgramsStore } from './programs.js'

export const CONSULT_TABS = ['programme', 'autre', 'salles', 'questions'] as const
export type ConsultTab = (typeof CONSULT_TABS)[number]

/**
 * La consultation : ce qu'on va chercher, jamais ce qu'on pilote.
 *
 * Une seule modale à quatre onglets plutôt que quatre modales, parce que
 * l'opérateur y entre pour répondre à une question — « où en est l'autre
 * salle ? », « qu'est-ce qui suit ? » — et qu'il change d'onglet en cours de
 * route. Quatre boutons dans l'en-tête et quatre modales à fermer l'une après
 * l'autre coûteraient plus que ce qu'ils rangent.
 */
export const useConsultStore = defineStore('consult', () => {
  const open = ref(false)
  const tab = ref<ConsultTab>('programme')
  /** Salle suivie dans l'onglet « Autre salle », ou `null` tant qu'on n'a pas choisi. */
  const followed = ref<string | null>(null)

  const programs = useProgramsStore()

  function show(which: ConsultTab): void {
    tab.value = which
    open.value = true
  }

  /** Programme d'une autre salle : chargé à la demande, pas dans le flux d'état. */
  async function follow(roomId: string): Promise<void> {
    followed.value = roomId
    tab.value = 'autre'
    open.value = true
    await programs.loadRoom(roomId)
  }

  return { open, tab, followed, show, follow }
})
