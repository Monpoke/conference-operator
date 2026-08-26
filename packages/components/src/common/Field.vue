<script setup lang="ts">
const model = defineModel<string>({ required: true })

defineProps<{
  id: string
  label: string
  /** Shown under the input: what it does, or what it will cost. */
  hint?: string
  type?: string
  placeholder?: string
}>()
</script>

<!--
  The label is bound by `for`/`id` rather than by wrapping, because half of
  these fields sit in a grid where the label and the input are not siblings.
-->
<template>
  <div class="mb-[11px]">
    <label class="mb-[5px] block text-xs text-attenue" :for="id">{{ label }}</label>
    <input
      :id="id"
      v-model="model"
      :type="type ?? 'text'"
      :placeholder="placeholder"
      class="w-full min-w-0 rounded-lg border border-bord bg-fond px-3 py-2.5 text-sm text-texte focus:border-marque focus:outline-none"
    />
    <p v-if="hint != null" class="mt-1 text-xs text-attenue">{{ hint }}</p>
  </div>
</template>
