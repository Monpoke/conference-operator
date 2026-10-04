<script setup lang="ts">
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui'

/**
 * A dialog, on Reka's primitives.
 *
 * What this buys, measured against the twelve modals it replaces — all of them
 * driven by an attribute on `<body>`:
 *
 *  - **a focus trap.** Tabbing out of "End early?" used to land on the LIVE and
 *    HOLD buttons *behind* the veil. In a dark room, that is a control over the
 *    projection sitting under a question nobody has answered yet.
 *  - **focus handed back** to whatever opened it.
 *  - `role="dialog"`, `aria-modal`, and a title wired through `aria-labelledby`.
 *    The headings were already there; nothing pointed at them.
 *  - **Escape closing the top layer only.** The old handler closed all five at
 *    once, so stacking the recordings modal over the schedule and pressing
 *    Escape dismissed both — which nobody expects.
 *
 * One of Reka's defaults is turned off on purpose — the scroll lock, see the note
 * below. The other one was, and must not be: `disableOutsidePointerEvents`.
 *
 * Reka blocks the outside by switching off `<body>`'s pointer events and
 * switching them back on, layer by layer, for whatever declared itself the
 * blocking layer. Setting the prop to `false` opted this content out of that
 * declaration while the overlay still made the declaration — so the overlay got
 * `pointer-events: auto` and the panel inherited the body's `none`. It rendered,
 * it was read, and it answered nothing: every click went through to the overlay
 * behind, which reads as an outside interaction and closes. A room reported it as
 * «&nbsp;la modale se ferme dès qu'on la touche&nbsp;».
 */
const open = defineModel<boolean>('open', { required: true })

defineProps<{
  title: string
  /** Read out with the title. Omit rather than repeat the title in other words. */
  description?: string
  width?: 'normal' | 'wide' | 'full'
}>()

const WIDTHS = {
  normal: 'max-w-[440px]',
  wide: 'max-w-[720px]',
  full: 'max-w-[min(1100px,92vw)]',
} as const
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/65" />
      <!--
        On a phone, the whole screen: a dialog floating at 90 % of a viewport the
        browser's bars keep resizing left its buttons out of reach, and « Fermer »
        at the bottom of a long folder meant scrolling it all. `dvh` follows the
        bars; the content scrolls between a fixed title and fixed buttons.
      -->
      <DialogContent
        class="fixed top-1/2 left-1/2 z-50 flex max-h-[90dvh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-edge bg-surface max-sm:inset-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-0"
        :class="WIDTHS[width ?? 'normal']"
        @open-auto-focus="
          /*
           * Reka focuses the first focusable child. Here that is often a
           * destructive button — «&nbsp;Refuser&nbsp;», «&nbsp;RAZ&nbsp;» — and
           * a reflex Enter would fire it. The dialog itself takes focus instead,
           * so the keyboard still works and nothing is armed.
           */
          (event: Event) => {
            event.preventDefault()
            ;(event.currentTarget as HTMLElement | null)?.focus()
          }
        "
      >
        <h2 class="shrink-0 px-4 pt-4 pb-2.5 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
          <DialogTitle>{{ title }}</DialogTitle>
        </h2>
        <div class="min-h-0 flex-1 overflow-y-auto px-4" data-role="dialog-body">
          <DialogDescription v-if="description != null" class="mb-2.5 text-sm text-dim">
            {{ description }}
          </DialogDescription>

          <slot />
        </div>

        <div class="flex shrink-0 flex-wrap justify-end gap-1.5 border-t border-edge px-4 py-3 max-sm:pb-[max(.75rem,env(safe-area-inset-bottom))]">
          <slot name="actions" />
          <DialogClose
            class="cursor-pointer rounded-lg border border-edge bg-surface2 px-3 py-2 text-[13px] font-semibold text-text"
          >
            Fermer
          </DialogClose>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style>
/*
 * Reka locks `<body>` scrolling and compensates for the vanished scrollbar with
 * a `padding-right`. In the console, the header is full width: compensating
 * makes it jump some fifteen pixels every time a dialog opens, which is visible
 * and unexplainable.
 *
 * Written here rather than as a utility because the rule targets an attribute set
 * by the library, which Tailwind cannot express.
 */
body[data-scroll-locked] {
  padding-right: 0 !important;
  margin-right: 0 !important;
}
</style>
