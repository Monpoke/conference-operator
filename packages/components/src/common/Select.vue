<script setup lang="ts">
const model = defineModel<string>({ required: true })

defineProps<{
  id: string
  label: string
  options: { value: string; label: string }[]
  hint?: string
}>()
</script>

<!--
  A native `<select>`, deliberately.

  Reka's Combobox earns its place where a list is long enough that somebody
  needs to type through it — picking a room out of a schedule, say. These lists
  are two to five entries; replacing them with a scripted popup would add a
  focus lifecycle, a keyboard model and a portal to something the platform
  already does, and would do it worse on the touchscreen the console sometimes
  runs on.
-->
<template>
  <div class="mb-[11px]">
    <label class="mb-[5px] block text-xs text-dim" :for="id">{{ label }}</label>
    <select
      :id="id"
      v-model="model"
      class="w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text focus:border-brand focus:outline-none"
    >
      <option v-for="option in options" :key="option.value" :value="option.value">
        {{ option.label }}
      </option>
    </select>
    <p v-if="hint != null" class="mt-1 text-xs text-dim">{{ hint }}</p>
  </div>
</template>
