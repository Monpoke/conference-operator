<script setup lang="ts">
import { computed } from 'vue'

/**
 * The contract version, shown only when the room and its hub disagree.
 *
 * A gap here explains failures that look like nothing else: an event the hub
 * refuses, a field that never arrives. Two identical versions — or a hub not heard
 * from yet — deserve no banner.
 */
const props = defineProps<{ protocol: { room: number; hub: number | null } | null }>()

const diverging = computed(
  () => props.protocol?.hub != null && props.protocol.hub !== props.protocol.room,
)
</script>

<template>
  <span v-if="diverging" class="shrink-0">
    <span
      class="rounded border border-alert/50 px-1.5 py-px text-[10px] font-semibold tracking-[.08em] text-alert uppercase"
      :title="`La salle parle la version ${protocol?.room} du contrat, le hub la version ${protocol?.hub} : mettez à jour le plus ancien.`"
    >
      protocole hub v{{ protocol?.hub }} · salle v{{ protocol?.room }}
    </span>
  </span>
</template>
