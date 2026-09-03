<script setup lang="ts">
import type { Level } from './levels.js'

/**
 * The same thing as the dot, lengthwise.
 *
 * It only applies to a **share of something**: the link with the hub is not one,
 * and an empty bar there would read as a measurement at zero rather than as a
 * missing measurement.
 */
const props = defineProps<{ percent: number; level: Level }>()

const width = (): string => `${Math.max(0, Math.min(100, props.percent))}%`
</script>

<template>
  <div class="gauge">
    <span :class="`level-${level}`" :style="{ width: width() }"></span>
  </div>
</template>

<style scoped>
.gauge {
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--color-edge);
}
.gauge > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--color-ok);
  transition: width 0.3s ease;
}
.gauge > span.level-warn {
  background: var(--color-warn);
}
.gauge > span.level-alert {
  background: var(--color-alert);
}
.gauge > span.level-unknown {
  background: var(--color-dim);
}
</style>
