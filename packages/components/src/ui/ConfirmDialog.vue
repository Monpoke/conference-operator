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
import { onBeforeUnmount, onMounted } from 'vue'
import Key from '../common/Key.vue'

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

const props = withDefaults(defineProps<{
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
  /**
   * Raises the title, for a question asked in a dark room mid-talk.
   *
   * The default reads as a section heading, which is right for a console
   * confirming an administrative gesture. It is wrong for a question that
   * interrupts: "Terminer en avance ?" has to be read before the buttons under
   * it are, and in a room lit only by the screen the size and the amber are
   * what does that.
   */
  tone?: 'quiet' | 'warn'
  /**
   * Keyboard letters printed on the two buttons — **and bound here**.
   *
   * They used to be labels only, with the binding left to whoever mounted the
   * dialog. Two dialogs out of four had one, so two out of four answered to the
   * keyboard, and nothing on screen told them apart. The rule that made that
   * necessary still holds — a printed key that does nothing is worse than none,
   * it gets pressed, nothing happens, and the operator stops trusting the other
   * ones — so the label and the binding now come from the same place and cannot
   * drift apart.
   *
   * `Y` and `N` by default, on every dialog. Pass `null` to print and bind
   * nothing.
   */
  cancelKey?: string | null
  confirmKey?: string | null
}>(), { cancelKey: 'N', confirmKey: 'Y' })

const emit = defineEmits<{ confirm: [] }>()

/**
 * The two answers, from the keyboard.
 *
 * In a dark room, aiming at a button costs more than pressing a key — the
 * reason the whole console has one-letter shortcuts. A dialog that interrupts a
 * talk is exactly where that matters most.
 *
 * Three guards, each paid for once already elsewhere:
 *
 * - **A key held with Ctrl, Cmd or Alt belongs to the browser.** `Ctrl+N` opens
 *   a window; reading the letter alone would cancel the dialog on the way out.
 * - **A keystroke aimed at a field belongs to the field.** The reset dialog
 *   arms its button by having a word typed into it, and `<select>` counts as
 *   much as a text input — the letter you press to reach an option must not
 *   answer the question behind it.
 * - **A disabled confirm stays disabled.** The key is the button, not a way
 *   around it.
 *
 * `o` confirms as well as `y`: half the operators type one and half the other,
 * and being wrong about the letter on this particular question costs a talk.
 * Only `Y` is printed — two letters on a button read as a word.
 */
function auClavier(event: KeyboardEvent): void {
  if (!open.value) return
  if (event.ctrlKey || event.metaKey || event.altKey) return

  const target = event.target as { tagName?: string; isContentEditable?: boolean } | null
  if (target?.isContentEditable === true) return
  const balise = target?.tagName
  if (balise === 'INPUT' || balise === 'SELECT' || balise === 'TEXTAREA') return

  const pressed = event.key.toLowerCase()
  const confirms = props.confirmKey != null && (pressed === props.confirmKey.toLowerCase() || pressed === 'o')
  const cancels = props.cancelKey != null && pressed === props.cancelKey.toLowerCase()
  if (!confirms && !cancels) return

  event.preventDefault()
  if (cancels) {
    open.value = false
    return
  }
  if (props.confirmDisabled === true) return
  // Closed first, as the button click does: what the gesture triggers can open
  // the next question, and it must not be covered by the one we have just
  // closed.
  open.value = false
  emit('confirm')
}

onMounted(() => {
  if (typeof document !== 'undefined') document.addEventListener('keydown', auClavier)
})
onBeforeUnmount(() => {
  if (typeof document !== 'undefined') document.removeEventListener('keydown', auClavier)
})
</script>

<template>
  <AlertDialogRoot v-model:open="open">
    <AlertDialogPortal>
      <AlertDialogOverlay class="fixed inset-0 z-50 bg-black/65" />
      <AlertDialogContent
        class="fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-edge bg-surface p-4"
      >
        <h2
          :class="
            tone === 'warn'
              ? 'mb-1.5 text-[17px] font-semibold text-warn'
              : 'mb-2.5 text-[11px] font-semibold tracking-[.14em] text-dim uppercase'
          "
        >
          <AlertDialogTitle>{{ title }}</AlertDialogTitle>
        </h2>
        <AlertDialogDescription v-if="detail != null" class="text-sm leading-relaxed">
          {{ detail }}
        </AlertDialogDescription>
        <div class="text-sm leading-relaxed"><slot /></div>

        <div class="mt-3.5 flex flex-wrap justify-end gap-1.5">
          <AlertDialogCancel
            class="cursor-pointer rounded-lg border border-edge bg-surface2 px-3 py-2 text-[13px] font-semibold text-text"
          >
            {{ cancelLabel ?? 'Annuler' }}<Key v-if="cancelKey != null">{{ cancelKey }}</Key>
          </AlertDialogCancel>
          <!--
            A third way out, between cancelling and confirming.

            "Commencer sans enregistrer" is neither: it is the action, taken
            with one guarantee dropped. Offering it as a second confirm button
            would read as two ways to say yes; offering it only as cancel would
            lose the gesture entirely.
          -->
          <slot name="other" />
          <AlertDialogAction
            :disabled="confirmDisabled === true"
            class="cursor-pointer rounded-lg border px-3 py-2 text-[13px] font-semibold disabled:cursor-not-allowed disabled:opacity-40"
            :class="
              danger === true
                ? 'border-[#6c2027] bg-[#3a1519] text-text'
                : 'border-brand bg-brand text-[#05070d]'
            "
            @click="emit('confirm')"
          >
            {{ confirmLabel }}<Key v-if="confirmKey != null">{{ confirmKey }}</Key>
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>
