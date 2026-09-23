<script setup lang="ts">
import { Button } from '@conference-operator/components'
import { move } from '../../stores/boucle.js'

/** Up, down, remove — for an item of any of the loop's lists. */
const props = defineProps<{ list: unknown[]; index: number; noun: string }>()

function remove(): void {
  props.list.splice(props.index, 1)
}
</script>

<template>
  <span class="flex shrink-0 gap-1">
    <Button size="small" :disabled="index === 0" :title="`Monter ${noun}`" data-action="up" @click="move(list, index, -1)">↑</Button>
    <Button
      size="small"
      :disabled="index === list.length - 1"
      :title="`Descendre ${noun}`"
      data-action="down"
      @click="move(list, index, 1)"
    >
      ↓
    </Button>
    <Button size="small" variant="danger" :title="`Retirer ${noun}`" data-action="remove" @click="remove">×</Button>
  </span>
</template>
