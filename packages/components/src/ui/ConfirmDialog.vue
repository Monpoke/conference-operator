<script setup lang="ts">
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
} from 'reka-ui'

/**
 * A decision that has to be made, not dismissed.
 *
 * `AlertDialog` rather than `Dialog`, and the difference is the point: it does
 * not close on a click outside, and it does not close on Escape alone. The
 * gestures behind these — resynchronising every room, wiping the day — are the
 * ones somebody is about to do while looking at something else, and a modal
 * that vanishes when the mouse slips is a modal that did not ask anything.
 *
 * The cancel button is focused first, not the action. In a dark room, a reflex
 * Enter on a dialog that just appeared must not be the thing that fires it.
 */
const open = defineModel<boolean>('open', { required: true })

defineProps<{
  title: string
  /** What exactly is about to happen, in a full sentence. */
  detail?: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  /**
   * Holds the action back until something has been done.
   *
   * For the gesture there is no coming back from: typing a word arms the
   * button, which is what separates having read from having clicked.
   */
  confirmDisabled?: boolean
}>()

const emit = defineEmits<{ confirm: [] }>()
</script>

<template>
  <AlertDialogRoot v-model:open="open">
    <AlertDialogPortal>
      <AlertDialogOverlay class="fixed inset-0 z-50 bg-black/65" />
      <AlertDialogContent
        class="fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-bord bg-surface p-4"
      >
        <h2 class="mb-2.5 text-[11px] font-semibold tracking-[.14em] text-attenue uppercase">
          <AlertDialogTitle>{{ title }}</AlertDialogTitle>
        </h2>
        <AlertDialogDescription v-if="detail != null" class="text-sm leading-relaxed">
          {{ detail }}
        </AlertDialogDescription>
        <div class="text-sm leading-relaxed"><slot /></div>

        <div class="mt-3.5 flex justify-end gap-1.5">
          <AlertDialogCancel
            class="cursor-pointer rounded-lg border border-bord bg-surface2 px-3 py-2 text-[13px] font-semibold text-texte"
          >
            {{ cancelLabel ?? 'Annuler' }}
          </AlertDialogCancel>
          <AlertDialogAction
            :disabled="confirmDisabled === true"
            class="cursor-pointer rounded-lg border px-3 py-2 text-[13px] font-semibold disabled:cursor-not-allowed disabled:opacity-40"
            :class="
              danger === true
                ? 'border-[#6c2027] bg-[#3a1519] text-texte'
                : 'border-marque bg-marque text-[#05070d]'
            "
            @click="emit('confirm')"
          >
            {{ confirmLabel }}
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>
