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

/**
 * What was just copied, and whether it worked.
 *
 * Kept in the component rather than sent to the toast stack: the answer belongs
 * to the button that was pressed. The stack sits at the bottom of the screen,
 * under a menu open at the top right, and an operator setting three OBS sources
 * in a row copies three times — three toasts saying the same thing tell them
 * nothing about which line they are on.
 */
const copied = ref<{ href: string; ok: boolean } | null>(null)
let clearTimer: ReturnType<typeof setTimeout> | null = null

/**
 * The address to paste, whole.
 *
 * The list holds paths, because that is what the links need; an OBS Browser
 * Source needs a complete address, in a field that resolves nothing. The base is
 * the page's own origin rather than a `127.0.0.1` written here: whoever reads
 * this page reached it at an address that answers, and that is the one their OBS
 * has a chance of reaching too — the local server listens on every interface.
 */
function addressOf(href: string): string {
  return new URL(href, globalThis.location.href).href
}

/**
 * Copies without assuming a secure context.
 *
 * `navigator.clipboard` is missing as soon as the page is read over the network
 * at `http://<ip>:7788` — a laptop set down beside the machine — where only
 * `127.0.0.1` counts as trusted. The old `execCommand` still answers there, so
 * it is kept behind it rather than leaving a button that does nothing on every
 * machine that is not the room's.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (globalThis.navigator?.clipboard != null) {
      await globalThis.navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Falls through: a refused permission is not a reason to give up on the
    // fallback, which asks for none.
  }

  try {
    const field = document.createElement('textarea')
    field.value = text
    field.setAttribute('readonly', '')
    // Off screen, and gone within the gesture: it exists only to be selected.
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.append(field)
    field.select()
    const done = document.execCommand('copy')
    field.remove()
    return done
  } catch {
    return false
  }
}

async function copy(href: string): Promise<void> {
  const ok = await copyText(addressOf(href))
  copied.value = { href, ok }
  if (clearTimer != null) clearTimeout(clearTimer)
  // Long enough to be read, short enough that the next line's answer cannot be
  // taken for this one's.
  clearTimer = setTimeout(() => (copied.value = null), 2000)
}

function labelOf(href: string): string {
  if (copied.value?.href !== href) return 'Copier'
  return copied.value.ok ? 'Copié' : 'Échec'
}

function closeAnywhere(): void {
  open.value = false
}

onMounted(() => document.addEventListener('click', closeAnywhere))
onBeforeUnmount(() => {
  document.removeEventListener('click', closeAnywhere)
  if (clearTimer != null) clearTimeout(clearTimer)
})
</script>

<template>
  <div class="relative">
    <Button size="small" data-role="btn-screens" @click.stop="open = !open">Écrans ▾</Button>
    <div
      v-if="open"
      class="absolute top-[calc(100%+6px)] right-0 z-20 min-w-[380px] rounded-[9px] border border-edge bg-surface p-[5px] shadow-[0_10px_30px_rgba(0,0,0,.45)]"
      data-role="screens-list"
    >
      <div
        v-for="link in links"
        :key="link.href"
        class="flex items-center gap-2 rounded-md px-3 py-2 hover:bg-edge"
      >
        <div class="min-w-0 flex-1">
          <div class="text-sm text-text">{{ link.title }}</div>
          <small class="mt-0.5 block text-xs break-all text-dim">{{ link.detail }}</small>
        </div>

        <!--
          Copying rather than opening.

          An OBS Browser Source is filled in by pasting an address, and the
          control window has no context menu to pull one out of a link: under
          Electron, the address of these screens was unreachable from the page
          that lists them.

          `.stop` keeps the menu open — the capture sources are set one after the
          other, and a menu that closed on each copy would have to be reopened
          between them.
        -->
        <Button
          size="small"
          class="shrink-0"
          :data-role="`btn-copy-${link.href}`"
          :title="addressOf(link.href)"
          @click.stop="copy(link.href)"
        >
          {{ labelOf(link.href) }}
        </Button>

        <!--
          A new tab: opening the projection in the control window would replace the
          commands with the room screen, in the middle of an intervention.

          A link rather than a `window.open`, though it is drawn as a button: it
          is what keeps the middle click working, and under Electron the main
          process reads the projection's address there to place it full screen on
          the video projector output.
        -->
        <a
          :href="link.href"
          target="_blank"
          rel="noopener"
          :data-role="`btn-open-${link.href}`"
          class="shrink-0 cursor-pointer rounded-lg border border-edge bg-surface2 px-3 py-2 text-[13px] font-semibold text-text no-underline transition-colors hover:border-brand hover:bg-edge"
        >
          Ouvrir
        </a>
      </div>
    </div>
  </div>
</template>
