<script setup lang="ts">
import { nextTick, onUnmounted, ref } from 'vue'

export interface ActionMenuItem {
  key: string
  label: string
  /** A link, opened in a new tab, rather than a gesture. */
  href?: string
  run?: () => unknown
  disabled?: boolean
  danger?: boolean
}

/**
 * Every action of a line, behind one button.
 *
 * Fixed rather than absolute: the lists scroll sideways, and would cut it off.
 * What cannot be done right now stays listed, greyed: it says it exists.
 */
const props = defineProps<{ items: readonly ActionMenuItem[]; label: string }>()
const open = ref(false)
const button = ref<HTMLButtonElement | null>(null)
const root = ref<HTMLElement | null>(null)
const place = ref<Record<string, string>>({})

function close(): void {
  if (!open.value) return
  open.value = false
  document.removeEventListener('pointerdown', onOutside)
  window.removeEventListener('scroll', close, true)
}
function onOutside(event: PointerEvent): void {
  if (!root.value?.contains(event.target as Node)) close()
}
async function toggle(): Promise<void> {
  if (open.value) return close()
  const rect = button.value!.getBoundingClientRect()
  const room = window.innerHeight - rect.bottom
  place.value = {
    right: `${Math.max(8, window.innerWidth - rect.right)}px`,
    ...(room < 280 ? { bottom: `${window.innerHeight - rect.top + 4}px` } : { top: `${rect.bottom + 4}px` }),
  }
  open.value = true
  document.addEventListener('pointerdown', onOutside)
  window.addEventListener('scroll', close, true)
  await nextTick()
  root.value?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus()
}
function choose(item: ActionMenuItem): void {
  close()
  item.run?.()
}
function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) {
    close()
    button.value?.focus()
  }
}
onUnmounted(close)
defineExpose({ items: props.items })
</script>

<template>
  <div ref="root" class="relative inline-block text-left" @keydown="onKey">
    <button
      ref="button"
      type="button"
      class="inline-flex size-9 cursor-pointer items-center justify-center rounded-lg border border-edge bg-surface2 text-lg leading-none text-text hover:border-dim focus-visible:outline-2 focus-visible:outline-brand"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-label="label"
      :title="label"
      data-role="actions"
      @click="toggle"
    >⋯</button>
    <div
      v-if="open"
      role="menu"
      class="fixed z-50 flex max-h-[70vh] min-w-56 flex-col overflow-y-auto rounded-lg border border-edge bg-surface p-1 shadow-lg"
      :style="place"
    >
      <template v-for="item in items" :key="item.key">
        <a
          v-if="item.href != null && !item.disabled"
          role="menuitem"
          :href="item.href"
          target="_blank"
          rel="noopener"
          class="rounded px-3 py-2 text-sm whitespace-nowrap text-text hover:bg-surface2 focus-visible:bg-surface2 focus-visible:outline-none"
          :data-action="item.key"
          @click="close"
        >{{ item.label }}</a>
        <button
          v-else
          type="button"
          role="menuitem"
          class="cursor-pointer rounded px-3 py-2 text-left text-sm whitespace-nowrap hover:bg-surface2 focus-visible:bg-surface2 focus-visible:outline-none disabled:cursor-default disabled:text-dim disabled:hover:bg-transparent"
          :class="item.danger ? 'text-alert' : 'text-text'"
          :disabled="item.disabled"
          :data-action="item.key"
          @click="choose(item)"
        >{{ item.label }}</button>
      </template>
    </div>
  </div>
</template>
