<script setup lang="ts">
import { computed } from 'vue'

/**
 * L'heure de la salle, celle sur laquelle tout le monde s'aligne.
 *
 * Une heure calée sur un hub à horloge simulée se lit de travers si on ne le
 * dit pas : voir 11:00 un matin d'août sans explication ferait douter de tout
 * le reste de l'écran. Le mot est accolé à l'heure plutôt que rangé dans
 * l'info-bulle du hub, parce que c'est l'heure elle-même qu'il qualifie.
 */
const props = defineProps<{ atMs: number; timeZone: string; simulated: boolean }>()

const shown = computed(() =>
  new Intl.DateTimeFormat('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: props.timeZone,
  }).format(new Date(props.atMs)),
)
</script>

<template>
  <div
    class="ml-auto flex shrink-0 items-baseline gap-1.5 text-[19px] font-semibold tabular-nums"
    :class="simulated ? 'text-warn' : ''"
  >
    {{ shown }}
    <span v-if="simulated" class="text-[10px] font-semibold tracking-[.1em] uppercase opacity-80">
      simulée
    </span>
  </div>
</template>
