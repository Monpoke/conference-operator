<script setup lang="ts">
import { Empty, Panel, useToast } from '@conference-operator/components'
import { DUREE_PLANNING_PAR_DEFAUT, MAX_PLANNINGS, type Planning } from '@conference-operator/contract'
import { onMounted, ref } from 'vue'
import { useDraft } from '../../composables/draft.js'
import { useBoucleStore } from '../../stores/boucle.js'
import { useSessionStore } from '../../stores/session.js'
import SaveBar from './SaveBar.vue'
import { SMALL } from './ui.js'

/**
 * The other rooms' schedules in the loop, room by room.
 *
 * Each screen shows its own room's day, then the others', each for the time set
 * here. A room left untouched is shown for the default duration; one taken out
 * no longer appears on any screen. The whole scene is withdrawn in Réglages,
 * with the other screens.
 */
const store = useBoucleStore()
const session = useSessionStore()
const toast = useToast()
const rooms = ref<{ id: string; name: string }[]>([])

const { draft, dirty, reset } = useDraft(() =>
  store.boucle == null ? null : { plannings: JSON.parse(JSON.stringify(store.boucle.plannings)) as Record<string, Planning> },
)

/** The row of a room, created on first touch: an untouched room stays absent. */
function reglage(roomId: string): Planning {
  const plannings = draft.value!.plannings
  plannings[roomId] ??= { afficher: true, duree: DUREE_PLANNING_PAR_DEFAUT }
  return plannings[roomId]
}

async function save(): Promise<void> {
  if (draft.value == null) return
  const plannings: Record<string, Planning> = {}
  for (const [roomId, value] of Object.entries(draft.value.plannings)) {
    const duree = Number(value.duree)
    if (!Number.isInteger(duree) || duree < 3 || duree > 600) {
      toast.fail('Durée d\'un planning : un nombre entier entre 3 et 600 secondes')
      return
    }
    // What says the default is not kept: a later default reaches it.
    if (value.afficher && duree === DUREE_PLANNING_PAR_DEFAUT) continue
    plannings[roomId] = { afficher: value.afficher, duree }
  }
  try {
    await store.save('plannings', plannings)
    reset()
    toast.say('Plannings enregistrés')
  } catch {
    /* already reported */
  }
}

onMounted(async () => {
  try {
    rooms.value = (await session.client.rpc.rooms.list()) as { id: string; name: string }[]
  } catch {
    /* already reported */
  }
})
</script>

<template>
  <Panel title="Plannings des autres salles">
    <div v-if="draft != null" id="boucle-plannings" class="flex flex-1 flex-col">
      <p class="mb-2 text-xs text-dim">
        Après l'agenda de la salle, la boucle montre la journée des autres salles ({{ MAX_PLANNINGS }} au plus).
      </p>
      <Empty v-if="rooms.length === 0">Aucune salle : importez le programme.</Empty>
      <div class="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1.5">
        <template v-for="room in rooms" :key="room.id">
          <label class="flex min-w-0 items-center gap-2 text-sm" :for="`boucle-planning-${room.id}-afficher`">
            <input
              :id="`boucle-planning-${room.id}-afficher`"
              :checked="draft.plannings[room.id]?.afficher ?? true"
              type="checkbox"
              class="w-auto"
              @change="reglage(room.id).afficher = ($event.target as HTMLInputElement).checked"
            />
            <span class="truncate">{{ room.name }}</span>
          </label>
          <input
            :id="`boucle-planning-${room.id}-duree`"
            :value="draft.plannings[room.id]?.duree ?? DUREE_PLANNING_PAR_DEFAUT"
            type="number"
            min="3"
            max="600"
            step="1"
            :disabled="(draft.plannings[room.id]?.afficher ?? true) === false"
            :class="[SMALL, 'w-20 text-right']"
            @change="reglage(room.id).duree = Number(($event.target as HTMLInputElement).value)"
          />
          <span class="text-xs text-dim">s</span>
        </template>
      </div>
      <SaveBar id="btn-boucle-plannings" :dirty="dirty" @save="save" />
    </div>
  </Panel>
</template>
