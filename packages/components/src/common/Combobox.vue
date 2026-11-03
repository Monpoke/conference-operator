<script setup lang="ts">
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxViewport,
} from 'reka-ui'
import { computed, ref } from 'vue'

/**
 * A long list one types through — a room out of a dozen.
 *
 * The case `Select.vue` leaves to this component. On Reka rather than a native
 * `<select>`: in an OBS dock the native dropdown opens empty. And floating in a
 * portal rather than in the flow: opened inside a dialog, the list must neither
 * be clipped by it nor make it grow. Reka stacks it as a layer of its own, so a
 * click in the list is not a click outside the dialog, and Escape closes the
 * list before the dialog.
 *
 * The field is an `<input>`: the one-letter shortcuts of the control app leave
 * it alone.
 */
const model = defineModel<string | null>({ required: true })

const props = defineProps<{
  options: { value: string; label: string; keywords?: string }[]
  /** Read out for the field, which has no visible label. */
  label: string
  placeholder: string
  empty?: string
}>()

const search = ref('')

/** Accents and case aside, every typed word somewhere: « amphi st » finds « Amphi St Louis ». */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

const shown = computed(() => {
  const words = fold(search.value).split(/\s+/).filter((word) => word !== '')
  return props.options.filter((option) => {
    const haystack = fold(`${option.label} ${option.keywords ?? ''}`)
    return words.every((word) => haystack.includes(word))
  })
})

const labelOf = (value: unknown): string =>
  props.options.find((option) => option.value === value)?.label ?? ''

/*
 * What is typed is the search, not the field's text.
 *
 * Reka writes the chosen option into the field; read back as a search, it left
 * only that option on the next opening. The term follows the keystrokes and
 * starts empty on every opening.
 */
function onOpen(): void {
  search.value = ''
}

/*
 * Typing over the chosen name, not after it.
 *
 * The field shows the option chosen; a click placed the caret at its end and the
 * next letters were appended to it — « RomarinCoquelicot », which matches
 * nothing. Selected once Reka has handled the click, the name is replaced by
 * what is typed.
 */
function selectChosen(event: Event): void {
  const field = event.target as HTMLInputElement
  if (field.value !== '' && field.value === labelOf(model.value)) requestAnimationFrame(() => field.select())
}
</script>

<template>
  <ComboboxRoot
    v-model="model"
    ignore-filter
    open-on-focus
    open-on-click
    class="w-full"
    @update:open="onOpen"
  >
    <ComboboxAnchor class="w-full">
      <ComboboxInput
        :display-value="labelOf"
        :aria-label="label"
        :placeholder="placeholder"
        autocomplete="off"
        spellcheck="false"
        class="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text placeholder:text-dim focus:border-brand focus:outline-none"
        data-role="combobox-input"
        @input="search = ($event.target as HTMLInputElement).value"
        @focus="selectChosen"
        @click="selectChosen"
      />
    </ComboboxAnchor>
    <ComboboxPortal>
      <ComboboxContent
        position="popper"
        :side-offset="4"
        class="z-[60] max-h-72 w-[var(--reka-combobox-trigger-width)] overflow-hidden rounded-lg border border-edge bg-surface p-1 shadow-[0_10px_30px_rgba(0,0,0,.45)]"
        data-role="combobox-list"
      >
        <ComboboxViewport class="max-h-[17rem] overflow-y-auto">
          <ComboboxEmpty class="px-3 py-2 text-sm text-dim">
            {{ empty ?? 'Aucun résultat.' }}
          </ComboboxEmpty>
          <ComboboxItem
            v-for="option in shown"
            :key="option.value"
            :value="option.value"
            class="cursor-pointer rounded-md px-3 py-2 text-sm text-text outline-none data-[highlighted]:bg-edge data-[state=checked]:font-semibold"
            :data-option="option.value"
          >
            {{ option.label }}
          </ComboboxItem>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>
