<script setup lang="ts">
/**
 * A label that changes without moving what surrounds it.
 *
 * Every label sits in the same grid cell, so a button takes the width of the
 * longest one. The others are drawn from an attribute rather than written as text:
 * nothing reads them out, and only the current label counts as the button's text.
 */
defineProps<{
  current: string
  labels: readonly string[]
}>()
</script>

<template>
  <span class="inline-grid justify-items-center">
    <span
      v-for="label in labels.filter((candidate) => candidate !== current)"
      :key="label"
      class="invisible col-start-1 row-start-1 whitespace-nowrap before:content-[attr(data-label)]"
      :data-label="label"
      aria-hidden="true"
    />
    <span class="col-start-1 row-start-1 whitespace-nowrap">{{ current }}</span>
  </span>
</template>
