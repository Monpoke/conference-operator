<script setup lang="ts">
/**
 * The keyboard shortcut printed on a command.
 *
 * Detached from the label and boxed, deliberately: stuck to the text it read as
 * one more letter — "EnregistrerR".
 */
</script>

<template>
  <span
    class="ml-2 rounded border border-current/30 px-1 py-px text-[10px] font-semibold opacity-60"
  >
    <slot />
  </span>
</template>
