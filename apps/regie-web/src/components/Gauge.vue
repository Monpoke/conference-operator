<script setup lang="ts">
import type { Level } from './levels.js'

/**
 * La même chose que la pastille, en longueur.
 *
 * Elle ne se pose que sur une **part de quelque chose** : le lien avec le hub
 * n'en est pas une, et une barre vide s'y lirait comme une mesure à zéro plutôt
 * que comme une mesure absente.
 */
const props = defineProps<{ percent: number; level: Level }>()

const width = (): string => `${Math.max(0, Math.min(100, props.percent))}%`
</script>

<template>
  <div class="jauge">
    <span :class="`niveau-${level}`" :style="{ width: width() }"></span>
  </div>
</template>

<style scoped>
.jauge {
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--color-edge);
}
.jauge > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--color-ok);
  transition: width 0.3s ease;
}
.jauge > span.niveau-warn {
  background: var(--color-warn);
}
.jauge > span.niveau-alert {
  background: var(--color-alert);
}
.jauge > span.niveau-inconnu {
  background: var(--color-dim);
}
</style>
