<script setup lang="ts">
import { effectiveEndAt } from '@cloudnord/room-state'
import { time } from '@cloudnord/format'
import type { Session } from '@cloudnord/program'
import { nextTick, onMounted, useTemplateRef, watch } from 'vue'

/**
 * A day of slots, the current one highlighted.
 *
 * The highlight is not decorative: the timeline spans a whole day, and without it
 * one opens the modal onto a wall of titles where finding the current hour takes
 * longer than one has. Hence the automatic scroll.
 */
const props = defineProps<{
  sessions: Session[]
  timeZone: string
  /**
   * The slot to highlight, or `null`.
   *
   * The room passes the real state it drives — a talk started late is still the
   * current talk. Another room passes what the program says at the hub's time: we
   * do not know its state, but we know its schedule.
   */
  currentId: string | null
  nowMs: number
}>()

const root = useTemplateRef<HTMLElement>('root')

/** Brings the current talk into view. */
function scrollToCurrent(): void {
  root.value?.querySelector('[data-current="true"]')?.scrollIntoView({ block: 'center' })
}

onMounted(() => void nextTick(scrollToCurrent))
watch(() => props.currentId, () => void nextTick(scrollToCurrent))

function speakers(session: Session): string {
  return (session.speakers ?? []).map((person) => person.name).join(' · ')
}

/** Past: dimmed. What is finished no longer competes with what is coming. */
function past(index: number): boolean {
  const end = effectiveEndAt(props.sessions, index)
  return end != null && end < props.nowMs
}
</script>

<template>
  <div v-if="sessions.length === 0" class="text-xs text-dim">Aucune session.</div>
  <div v-else ref="root" class="flex flex-col gap-1" data-role="timeline">
    <div
      v-for="(session, index) in sessions"
      :key="session.id"
      class="grid grid-cols-[52px_1fr] items-baseline gap-2.5 rounded-md px-2.5 py-2"
      :class="[
        session.id === currentId
          ? 'bg-[color-mix(in_srgb,var(--color-brand)_22%,transparent)] shadow-[inset_3px_0_0_var(--color-brand)]'
          : past(index)
            ? 'opacity-35'
            : '',
        session.kind === 'break' ? 'opacity-50' : '',
      ]"
      :data-current="session.id === currentId ? 'true' : undefined"
    >
      <div class="text-[13px] text-dim tabular-nums">
        {{ time(session.startsAt, timeZone) }}
      </div>
      <div>
        <div class="text-sm">{{ session.title }}</div>
        <div v-if="speakers(session) !== ''" class="mt-0.5 text-xs text-dim">
          {{ speakers(session) }}
        </div>
      </div>
    </div>
  </div>
</template>
