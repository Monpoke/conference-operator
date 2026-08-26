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
 * Two of Reka's defaults are turned off on purpose, and both would be visible:
 * see the scroll-lock note below, and `@interactOutside` on touch screens.
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
      <DialogContent
        class="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-bord bg-surface p-4"
        :class="WIDTHS[width ?? 'normal']"
        :disable-outside-pointer-events="false"
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
        <h2 class="mb-2.5 text-[11px] font-semibold tracking-[.14em] text-attenue uppercase">
          <DialogTitle>{{ title }}</DialogTitle>
        </h2>
        <DialogDescription v-if="description != null" class="mb-2.5 text-sm text-attenue">
          {{ description }}
        </DialogDescription>

        <slot />

        <div class="mt-3.5 flex justify-end gap-1.5">
          <slot name="actions" />
          <DialogClose
            class="cursor-pointer rounded-lg border border-bord bg-surface2 px-3 py-2 text-[13px] font-semibold text-texte"
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
 * Reka verrouille le défilement du `<body>` et compense la barre disparue par
 * un `padding-right`. Sur la console, l'en-tête est en pleine largeur : le
 * compenser le fait sauter d'une quinzaine de pixels à chaque ouverture de
 * modale, ce qui se voit et ne s'explique pas.
 *
 * Écrit ici plutôt qu'en utilitaire parce que la règle vise un attribut posé
 * par la bibliothèque, ce que Tailwind n'exprime pas.
 */
body[data-scroll-locked] {
  padding-right: 0 !important;
  margin-right: 0 !important;
}
</style>
