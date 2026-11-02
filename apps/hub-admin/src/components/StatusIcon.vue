<script setup lang="ts">
import Spinner from './Spinner.vue'

/**
 * A state at a glance: the shape says what it is about, the colour how it stands,
 * the tooltip says it in words. Drawn inline (Lucide's strokes), like `HeaderIcon`.
 */
defineProps<{ name: 'upload' | 'eye' | 'eye-off' | 'image'; tone: 'ok' | 'warn' | 'alert' | 'brand' | 'off'; label: string; spin?: boolean }>()

const TONES = { ok: 'text-ok', warn: 'text-warn', alert: 'text-alert', brand: 'text-brand', off: 'text-dim opacity-50' } as const
</script>

<template>
  <span class="inline-flex size-5 items-center justify-center" :class="TONES[tone]" role="img" :aria-label="label" :title="label" :data-status="name" :data-tone="tone">
    <Spinner v-if="spin" />
    <svg v-else class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <template v-if="name === 'upload'">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" />
      </template>
      <template v-else-if="name === 'eye'">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" />
      </template>
      <template v-else-if="name === 'eye-off'">
        <path d="M9.9 5.2A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.2" /><path d="M6.6 6.6C3.6 8.6 2 12 2 12s3.5 7 10 7c1.9 0 3.5-.5 5-1.4" /><path d="m2 2 20 20" />
      </template>
      <template v-else>
        <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
      </template>
    </svg>
  </span>
</template>
