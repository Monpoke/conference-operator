<script setup lang="ts">
const model = defineModel<string>({ required: true })

defineProps<{
  id: string
  label: string
  /** Shown under the input: what it does, or what it will cost. */
  hint?: string
  type?: string
  placeholder?: string
  /**
   * What the keychain should offer, and which keyboard to open.
   *
   * Irrelevant on a control machine, decisive on a phone: it decides whether you
   * type an address by hand at the back of a dark room or the password manager
   * fills it in. Passed to the `input` and not left as fallthrough attributes,
   * which would land on the `div`.
   */
  autocomplete?: string
  inputmode?: 'text' | 'email' | 'numeric' | 'tel' | 'url' | 'search' | 'none' | 'decimal'
}>()
</script>

<!--
  The label is bound by `for`/`id` rather than by wrapping, because half of
  these fields sit in a grid where the label and the input are not siblings.
-->
<template>
  <div class="mb-[11px]">
    <label class="mb-[5px] block text-xs text-dim" :for="id">{{ label }}</label>
    <input
      :id="id"
      v-model="model"
      :type="type ?? 'text'"
      :placeholder="placeholder"
      :autocomplete="autocomplete"
      :inputmode="inputmode"
      class="w-full min-w-0 rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text focus:border-brand focus:outline-none"
    />
    <p v-if="hint != null" class="mt-1 text-xs text-dim">{{ hint }}</p>
  </div>
</template>
