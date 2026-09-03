<script setup lang="ts">
import { effectiveEndAt } from '@cloudnord/room-state'
import { time } from '@cloudnord/format'
import type { Session } from '@cloudnord/program'
import { nextTick, onMounted, useTemplateRef, watch } from 'vue'

/**
 * Une journée de créneaux, celui en cours surligné.
 *
 * Le surlignage n'est pas décoratif : la timeline fait une journée entière, et
 * sans lui on ouvre la modale sur un mur de titres où retrouver l'heure qu'il
 * est prend plus de temps qu'on n'en a. D'où le défilement automatique.
 */
const props = defineProps<{
  sessions: Session[]
  timeZone: string
  /**
   * Créneau à surligner, ou `null`.
   *
   * La salle passe l'état réel qu'elle pilote — un talk lancé en retard reste
   * le talk en cours. Une autre salle passe ce que dit le programme à l'heure
   * du hub : on ne connaît pas son état, mais on connaît son horaire.
   */
  currentId: string | null
  nowMs: number
}>()

const root = useTemplateRef<HTMLElement>('root')

/** Amène la conférence en cours sous les yeux. */
function scrollToCurrent(): void {
  root.value?.querySelector('[data-actuel="true"]')?.scrollIntoView({ block: 'center' })
}

onMounted(() => void nextTick(scrollToCurrent))
watch(() => props.currentId, () => void nextTick(scrollToCurrent))

function speakers(session: Session): string {
  return (session.speakers ?? []).map((person) => person.name).join(' · ')
}

/** Passé : atténué. Ce qui est fini n'a plus à concurrencer ce qui vient. */
function past(index: number): boolean {
  const end = effectiveEndAt(props.sessions, index)
  return end != null && end < props.nowMs
}
</script>

<template>
  <div v-if="sessions.length === 0" class="text-xs text-attenue">Aucune session.</div>
  <div v-else ref="root" class="flex flex-col gap-1" data-role="timeline">
    <div
      v-for="(session, index) in sessions"
      :key="session.id"
      class="grid grid-cols-[52px_1fr] items-baseline gap-2.5 rounded-md px-2.5 py-2"
      :class="[
        session.id === currentId
          ? 'bg-[color-mix(in_srgb,var(--color-marque)_22%,transparent)] shadow-[inset_3px_0_0_var(--color-marque)]'
          : past(index)
            ? 'opacity-35'
            : '',
        session.kind === 'break' ? 'opacity-50' : '',
      ]"
      :data-actuel="session.id === currentId ? 'true' : undefined"
    >
      <div class="text-[13px] text-attenue tabular-nums">
        {{ time(session.startsAt, timeZone) }}
      </div>
      <div>
        <div class="text-sm">{{ session.title }}</div>
        <div v-if="speakers(session) !== ''" class="mt-0.5 text-xs text-attenue">
          {{ speakers(session) }}
        </div>
      </div>
    </div>
  </div>
</template>
