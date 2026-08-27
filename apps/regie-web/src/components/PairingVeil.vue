<script setup lang="ts">
import type { DisplayPayload } from '@cloudnord/contract'
import { Button } from '@cloudnord/components'
import { computed } from 'vue'
import { useActionsStore } from '../stores/actions.js'

/**
 * Un état, et surtout pas une modale.
 *
 * Rien de ce qu'il recouvre n'est utilisable : une machine non appairée n'a ni
 * salle, ni programme, ni OBS à piloter. Une modale se ferme — sur Échap, sur
 * un clic à côté — et laisserait une régie complète à l'écran, dont chaque
 * bouton échouerait sans dire pourquoi. Le voile occupe l'écran tant que la
 * condition dure, et disparaît quand elle cesse. Il n'a pas de bouton fermer
 * parce qu'il n'y a rien derrière.
 *
 * Il ne pose pas de couche clavier non plus : c'est la page qui retire la
 * sienne tant qu'il est là. Les raccourcis agissent sur une conférence et un
 * OBS que cette machine ne connaît pas encore.
 */
const TITLES: Record<string, string> = {
  idle: 'Appairage de la salle',
  waiting: 'Appairage de la salle',
  // Un jeton refusé n'est pas un premier démarrage : le dire évite de croire à
  // une machine neuve alors qu'elle a été révoquée, ou que la base du hub a été
  // recréée.
  expired: 'Cette machine doit être réappairée',
  failed: 'Appairage impossible',
}

const props = defineProps<{ pairing: DisplayPayload['pairing'] }>()

const actions = useActionsStore()

/** Tant qu'aucun code n'a été demandé, c'est la salle qu'on choisit. */
const choosing = computed(() => props.pairing?.userCode == null)

const rooms = computed(() => props.pairing?.rooms ?? [])

const requested = computed(
  () => rooms.value.find((room) => room.id === props.pairing?.requestedRoomId) ?? null,
)

const title = computed(() =>
  choosing.value
    ? 'Quelle salle dessert ce poste ?'
    : (TITLES[props.pairing?.status ?? ''] ?? 'Appairage de la salle'),
)
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-fond p-6" data-role="pairing">
    <div class="max-w-[620px] rounded-2xl border border-bord bg-surface px-10 py-[34px] text-center">
      <h1 class="mb-2 text-[22px] font-semibold">{{ title }}</h1>
      <p class="mb-6 text-[15px] leading-relaxed text-attenue">
        {{
          choosing
            ? 'Ce choix accompagne la demande : la console le retrouvera pré-sélectionné.'
            : "Cette machine n'est pas encore liée à une salle."
        }}
      </p>

      <div v-if="choosing" class="mb-2 flex flex-col gap-3">
        <!--
          Hub injoignable : le dire plutôt que d'afficher une liste vide, qui se
          lirait comme un événement sans salles.
        -->
        <p v-if="rooms.length === 0" class="py-3.5 text-sm text-attenue">
          Hub injoignable — la liste des salles apparaîtra dès qu'il répondra.
        </p>
        <Button
          v-for="room in rooms"
          :key="room.id"
          class="flex items-center justify-between px-5 py-4 text-left text-[17px]"
          :data-room="room.id"
          @click="actions.act({ action: 'pairing.chooseRoom', roomId: room.id })"
        >
          {{ room.name }}<span class="opacity-50">→</span>
        </Button>
      </div>

      <template v-else>
        <p v-if="requested != null" class="mb-3.5 text-sm text-attenue">
          Salle demandée : <strong class="text-texte">{{ requested.name }}</strong>
        </p>
        <div
          class="mb-5 rounded-xl border border-bord bg-fond px-[26px] py-5 text-[52px] font-bold tracking-[.16em] tabular-nums select-all"
          data-role="pairing-code"
        >
          {{ pairing?.userCode ?? '········' }}
        </div>
        <p class="text-sm leading-relaxed text-attenue">
          Saisissez ce code dans la console du hub, onglet « Machines en attente », puis
          choisissez la salle desservie par ce poste.<br />
          <a
            v-if="pairing?.verificationUri != null"
            class="text-marque underline"
            :href="pairing.verificationUri"
            target="_blank"
            rel="noopener"
            >{{ pairing.verificationUri }}</a
          >
        </p>
      </template>

      <p v-if="pairing?.message != null" class="mt-[18px] text-sm text-alerte">
        {{ pairing.message }}
      </p>
      <p class="mt-[22px] text-[13px] text-attenue">Cet écran disparaît dès l'approbation.</p>
    </div>
  </div>
</template>
