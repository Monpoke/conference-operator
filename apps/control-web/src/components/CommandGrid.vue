<script setup lang="ts">
import { Button, Key } from '@cloudnord/components'
import { useActionsStore } from '../stores/actions.js'

/** A command in the grid: its value, its label, its key if it has one. */
export interface Command {
  value: string
  label: string
  key?: string
}

/**
 * A grid of mutually exclusive commands — a screen mode, a scene role.
 *
 * The "active" button does not say what was asked for, it says **where the room
 * stands**: it follows the payload, not the click. That is the actions store's
 * rule, and it shows here — nothing writes into the state on click.
 */
const props = defineProps<{
  commands: Command[]
  /** The value in force, as the stream reports it. */
  current: string | null
  /** What gets posted for a given value. */
  build: (value: string) => Record<string, unknown>
}>()

const actions = useActionsStore()
</script>

<template>
  <div class="grid grid-cols-2 gap-1.5">
    <Button
      v-for="command in props.commands"
      :key="command.value"
      class="leading-tight whitespace-normal"
      :active="command.value === props.current"
      :data-command="command.value"
      @click="actions.act(props.build(command.value))"
    >
      {{ command.label }}
      <Key v-if="command.key != null">{{ command.key }}</Key>
    </Button>
  </div>
</template>
