<script setup lang="ts">
import type { ControlDiagnostics } from '@cloudnord/contract'
import { shortDuration } from '@cloudnord/format'
import { computed } from 'vue'

/**
 * How long it has been running.
 *
 * Two possible clocks, and the payload carries which one: a
 * `startedAtCorrectedMs` that is set means "count on the hub's clock" — the
 * development case, where a day is run through by pushing it, and where the
 * stopwatch must say the same thing as the duration finally recorded. Absent, we
 * count in real time, as in production.
 *
 * One deliberate departure from the original page, and the only one: past the
 * hour it showed "90:00", this format shows "1:30:00". A take longer than an hour
 * does happen — keynotes — and a count in minutes alone reads badly there.
 */
const props = defineProps<{
  recording: ControlDiagnostics['recording'] | null
  /** The machine's real time. */
  realMs: number
  /** The room's time, the hub's offset included. */
  roomMs: number
}>()

const startedAt = computed(() =>
  props.recording?.active === true
    ? (props.recording.startedAtCorrectedMs ?? props.recording.startedAtMs)
    : null,
)

const followsHub = computed(
  () => props.recording?.active === true && props.recording.startedAtCorrectedMs != null,
)

const elapsed = computed(() => {
  const start = startedAt.value
  if (start == null) return null
  return Math.max(0, (followsHub.value ? props.roomMs : props.realMs) - start)
})
</script>

<template>
  <span
    class="text-[22px] font-bold tabular-nums"
    :class="elapsed == null ? 'text-dim' : ''"
    data-role="recording-timer"
  >
    {{ elapsed == null ? '00:00' : shortDuration(elapsed) }}
  </span>
</template>
