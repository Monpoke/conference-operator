<script setup lang="ts">
import type { ExecutionMode } from '@conference-operator/contract'
import { computed } from 'vue'

/**
 * The run mode, shown only when it is not the one being assumed.
 *
 * It is their **disagreement** that counts: a development room plugged into the
 * event's hub would send real commands from a machine that simulates everything.
 * Two production modes deserve no banner — that would be permanent noise for no
 * information at all.
 */
const props = defineProps<{ mode: { room: ExecutionMode; hub: ExecutionMode | null } | null }>()

const diverging = computed(() => props.mode?.hub != null && props.mode.hub !== props.mode.room)

const shown = computed(
  () => props.mode != null && !(props.mode.room === 'production' && (props.mode.hub ?? 'production') === 'production'),
)

const text = computed(() => {
  if (!diverging.value) return 'mode dev'
  return props.mode?.room === 'dev' ? 'dev · hub en production' : 'hub en dev'
})
</script>

<template>
  <span v-if="shown" class="shrink-0">
    <span
      class="rounded border px-1.5 py-px text-[10px] font-semibold tracking-[.08em] uppercase"
      :class="diverging ? 'border-alert/50 text-alert' : 'border-warn/40 text-warn'"
    >
      {{ text }}
    </span>
  </span>
</template>
