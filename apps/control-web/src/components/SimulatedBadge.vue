<script setup lang="ts">
/**
 * Nothing on screen tells a simulated recording from a real one: same buttons,
 * same stopwatch, same sidecar written. The only difference is that no camera is
 * plugged in behind it — hence this reminder everywhere one believes one is
 * driving OBS.
 */
defineProps<{ when: boolean }>()
</script>

<template>
  <span
    v-if="when"
    class="ml-1.5 rounded border border-warn/40 px-1 py-px text-[10px] font-semibold tracking-[.08em] text-warn uppercase"
  >
    simulé
  </span>
</template>
