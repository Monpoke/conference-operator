<script setup lang="ts">
import type { DisplayPayload } from '@conference-operator/contract'
import { Button } from '@conference-operator/components'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * The locally served screens.
 *
 * Opening them from the control app saves having to remember addresses: on the
 * day, nobody types http://127.0.0.1:7788/display/overlay from memory.
 */
const SCREENS = [
  ['/display/projector', 'Projection', "Ce que voit la salle — Browser Source d'OBS-A"],
  ['/display/overlay', 'Habillage captation', 'Superposé à la vidéo dans OBS-B'],
  ['/display/overlay-live', 'Bandeau live', 'Question en haut — sobre sur un plan caméra'],
  [
    '/display/overlay-live?style=encart',
    'Encart live',
    'Question en carte, en bas à droite — par-dessus des slides',
  ],
  ['/regie', 'Régie', 'Cette page, dans une autre fenêtre'],
] as const

const props = defineProps<{ payload: DisplayPayload }>()

const open = ref(false)

/**
 * The public wall depends on the hub, not on the local server.
 *
 * Added only when the room knows its address: a dead link in this list would send
 * people looking for a network failure where there is only a missing setting.
 */
const links = computed(() => {
  const wall = props.payload.wall?.url
  return wall == null
    ? SCREENS.map((entry) => ({ href: entry[0], title: entry[1], detail: entry[2] }))
    : [
        ...SCREENS.map((entry) => ({ href: entry[0], title: entry[1], detail: entry[2] })),
        { href: wall, title: 'Mur public', detail: wall },
      ]
})

function closeAnywhere(): void {
  open.value = false
}

onMounted(() => document.addEventListener('click', closeAnywhere))
onBeforeUnmount(() => document.removeEventListener('click', closeAnywhere))
</script>

<template>
  <div class="relative">
    <Button size="small" data-role="btn-screens" @click.stop="open = !open">Écrans ▾</Button>
    <div
      v-if="open"
      class="absolute top-[calc(100%+6px)] right-0 z-20 min-w-[260px] rounded-[9px] border border-edge bg-surface p-[5px] shadow-[0_10px_30px_rgba(0,0,0,.45)]"
      data-role="screens-list"
    >
      <!--
        A new tab: opening the projection in the control window would replace the
        commands with the room screen, in the middle of an intervention.
      -->
      <a
        v-for="link in links"
        :key="link.href"
        :href="link.href"
        target="_blank"
        rel="noopener"
        class="block rounded-md px-3 py-2.5 text-sm text-text no-underline hover:bg-edge"
      >
        {{ link.title }}
        <small class="mt-0.5 block text-xs text-dim">{{ link.detail }}</small>
      </a>
    </div>
  </div>
</template>
