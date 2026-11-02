<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'

/**
 * A long view's sections: a column on a computer, one scrolling line on a phone.
 *
 * Links, like the tabs: a section is an address that survives a reload.
 */
export interface SectionEntry {
  id: string
  label: string
  path: string
  /** What needs doing there. Nothing shows when it is empty. */
  alerts?: string[]
}

const props = defineProps<{ name: string; label: string; entries: SectionEntry[]; current: string }>()

/** Keep the current section in view on a phone: a badge arriving late widens the line. */
const menu = ref<HTMLElement | null>(null)
function revealCurrent(): void {
  void nextTick(() => {
    menu.value
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView?.({ inline: 'center', block: 'nearest' })
  })
}
onMounted(revealCurrent)
watch([() => props.current, () => props.entries.flatMap((entry) => entry.alerts ?? []).length], revealCurrent)
</script>

<template>
  <nav
    ref="menu"
    :aria-label="label"
    class="flex gap-1 max-md:-mx-1 max-md:overflow-x-auto max-md:px-1 max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden md:sticky md:top-3 md:flex-col"
  >
    <RouterLink
      v-for="entry in entries"
      :id="`${name}-${entry.id}`"
      :key="entry.id"
      :to="entry.path"
      class="flex shrink-0 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[13px] whitespace-nowrap"
      :class="current === entry.id ? 'border-edge bg-surface2 text-text' : 'border-transparent text-dim'"
      :aria-current="current === entry.id ? 'page' : undefined"
    >
      {{ entry.label }}
      <span
        v-if="(entry.alerts?.length ?? 0) > 0"
        :data-alerts="entry.id"
        :title="entry.alerts!.join('\n')"
        :aria-label="entry.alerts!.join(' ; ')"
        class="rounded-full bg-alert/15 px-1.5 text-[11px] font-semibold text-alert tabular-nums"
      >{{ entry.alerts!.length }}</span>
    </RouterLink>
  </nav>
</template>
