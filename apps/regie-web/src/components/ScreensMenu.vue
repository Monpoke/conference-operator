<script setup lang="ts">
import type { DisplayPayload } from '@cloudnord/contract'
import { Button } from '@cloudnord/components'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * Les écrans servis localement.
 *
 * Les ouvrir depuis la régie évite de retenir des adresses : le jour J,
 * personne ne tape http://127.0.0.1:7788/display/overlay de mémoire.
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
 * Le mur public dépend du hub, pas du serveur local.
 *
 * Ajouté seulement quand la salle en connaît l'adresse : un lien mort dans
 * cette liste enverrait chercher une panne de réseau là où il n'y a qu'un
 * réglage absent.
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
    <Button size="small" data-role="btn-ecrans" @click.stop="open = !open">Écrans ▾</Button>
    <div
      v-if="open"
      class="absolute top-[calc(100%+6px)] right-0 z-20 min-w-[260px] rounded-[9px] border border-bord bg-surface p-[5px] shadow-[0_10px_30px_rgba(0,0,0,.45)]"
      data-role="liste-ecrans"
    >
      <!--
        Nouvel onglet : ouvrir la projection dans la fenêtre de régie
        remplacerait les commandes par l'écran de salle, en pleine intervention.
      -->
      <a
        v-for="link in links"
        :key="link.href"
        :href="link.href"
        target="_blank"
        rel="noopener"
        class="block rounded-md px-3 py-2.5 text-sm text-texte no-underline hover:bg-bord"
      >
        {{ link.title }}
        <small class="mt-0.5 block text-xs text-attenue">{{ link.detail }}</small>
      </a>
    </div>
  </div>
</template>
