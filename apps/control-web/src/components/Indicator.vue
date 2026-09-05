<script setup lang="ts">
import { StatusDot } from '@conference-operator/components'
import { computed } from 'vue'
import Gauge from './Gauge.vue'
import type { Level } from './levels.js'

/**
 * A header indicator: its dot, its tooltip, and what a screen reader will say of
 * it.
 *
 * Both indicators go through here, and that is the point: they read at a single
 * glance because they are built by a single hand — the colour in the same place,
 * the verdict in the same place, the figure in the same format. Two separate
 * renderings would have diverged at the first addition.
 *
 * The native tooltip said the same thing, but after a second's wait, in the
 * system font, and without being able to colour the figure — which is precisely
 * all the information.
 *
 * `data-level` drives no colour, contrary to what the original page claimed: no
 * rule ever read it. It stays because it is what the tests observe — the level
 * chosen for the dot, exposed without going through a utility class that could
 * change name.
 */
const props = defineProps<{
  title: string
  /** The measurement, already formatted. A string: "42 %", "Connecté", "—". */
  value: string
  /** The verdict in two words, to the right of the figure. */
  label: string
  /** The block's level — the dot's, readable from the other end of the room. */
  level: Level
  /**
   * The measurement's own level, when it differs from the block's.
   *
   * A processor at rest stays green under a red memory dot: the large figure's
   * colour is that of *its* measurement, not the block's.
   */
  valueLevel?: Level
  /** The measured share, 0 to 100. Omitted when the measurement is not a share. */
  gauge?: number
  detail: string
  verdict: string
  /**
   * What the screen reader announces.
   *
   * The tooltip is decorative: all it does is lay this sentence out. Rebuilt from
   * the fields when it is not supplied.
   */
  summary?: string
}>()

const tint = computed(() => `level-${props.valueLevel ?? props.level}`)

const spoken = computed(
  () =>
    props.summary ??
    `${props.title} : ${props.value}, ${props.label} — ${props.detail}. ${props.verdict}`,
)
</script>

<template>
  <div
    class="indicator relative flex shrink-0 items-center gap-1.5 text-xs text-dim"
    tabindex="0"
    :data-level="level"
    :aria-label="spoken"
  >
    <StatusDot :level="level" />
    <!--
      The word beside the dot: "hors ligne", "Poste".

      The screen reader reads the block's `aria-label`, which is focusable: the
      tooltip repeated word for word the same thing, cut into five unordered
      fragments. Hence `aria-hidden` on it, and nothing here.
    -->
    <span><slot /></span>
    <div class="tooltip" aria-hidden="true">
      <div class="text-[10px] font-semibold tracking-[.12em] text-dim uppercase">
        {{ title }}
      </div>
      <div class="mt-1 mb-2 flex items-baseline gap-2">
        <span :class="tint" class="text-[22px] leading-none font-semibold tabular-nums">
          {{ value }}
        </span>
        <span :class="tint" class="ml-auto text-right text-[11px] font-semibold">{{ label }}</span>
      </div>
      <Gauge v-if="gauge != null" :percent="gauge" :level="valueLevel ?? level" />
      <div class="mt-1.5 text-[11px] text-dim">{{ detail }}</div>
      <slot name="extra" />
      <div class="mt-2 border-t border-edge pt-2 text-xs leading-snug text-text">
        {{ verdict }}
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * Written by hand rather than in utilities: it hangs on three things no class
 * expresses — appearing on hover *and* on keyboard focus, the arrow in ::before,
 * and a background that has to continue the block's corner.
 */
.indicator {
  cursor: help;
}
.indicator .tooltip {
  position: absolute;
  top: calc(100% + 9px);
  left: -10px;
  z-index: 30;
  width: 270px;
  padding: 11px 13px;
  border: 1px solid var(--color-edge);
  border-radius: 10px;
  background: var(--color-surface2);
  color: var(--color-text);
  box-shadow: 0 12px 30px rgb(0 0 0 / 0.5);
  opacity: 0;
  transform: translateY(-4px);
  pointer-events: none;
  transition:
    opacity 0.12s ease,
    transform 0.12s ease;
}
/* The arrow continues the corner: same background, and the two edges it crosses. */
.indicator .tooltip::before {
  content: '';
  position: absolute;
  top: -5px;
  left: 15px;
  width: 8px;
  height: 8px;
  background: var(--color-surface2);
  transform: rotate(45deg);
  border-left: 1px solid var(--color-edge);
  border-top: 1px solid var(--color-edge);
}
.indicator:hover .tooltip,
.indicator:focus-visible .tooltip {
  opacity: 1;
  transform: translateY(0);
}
.indicator:focus-visible {
  outline: none;
}

/*
 * A single colour vocabulary, from the figure to the gauge.
 *
 * `:deep()` because the memory panel arrives through a slot: it carries the
 * caller's scope, not this one's, and without it its percentage would stay the
 * colour of the surrounding text.
 */
.indicator :deep(.level-ok) {
  color: var(--color-ok);
}
.indicator :deep(.level-warn) {
  color: var(--color-warn);
}
.indicator :deep(.level-alert) {
  color: var(--color-alert);
}
.indicator :deep(.level-unknown) {
  color: var(--color-dim);
}
</style>
