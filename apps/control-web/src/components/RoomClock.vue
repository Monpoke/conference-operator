<script setup lang="ts">
import { computed } from 'vue'

/**
 * The room's time, the one everyone aligns on.
 *
 * A time set against a hub on a simulated clock reads wrong if that is not said:
 * seeing 11:00 on an August morning with no explanation would cast doubt on
 * everything else on screen. The word sits beside the time rather than tucked
 * into the hub's tooltip, because it is the time itself that it qualifies.
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
