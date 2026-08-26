<script setup lang="ts">
defineProps<{
  /** Rendered as the panel's heading when given. */
  title?: string
}>()
</script>

<!--
  No `min-h-0` here: inside a scrolling column it lets the panel shrink below
  its own content, and panels start overlapping. The rare panel that must
  shrink to scroll inside itself asks for it explicitly.
-->
<template>
  <section class="flex shrink-0 flex-col rounded-xl border border-bord bg-surface p-4">
    <h2
      v-if="title != null"
      class="mb-2.5 text-[11px] font-semibold tracking-[.14em] text-attenue uppercase"
    >
      {{ title }}
    </h2>
    <slot />
  </section>
</template>
