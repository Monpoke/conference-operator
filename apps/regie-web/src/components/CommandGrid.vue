<script setup lang="ts">
import { Button, Key } from '@cloudnord/components'
import { useActionsStore } from '../stores/actions.js'

/** Une commande de la grille : sa valeur, son libellé, sa touche s'il y en a une. */
export interface Command {
  value: string
  label: string
  key?: string
}

/**
 * Une grille de commandes exclusives — un mode d'écran, un rôle de scène.
 *
 * Le bouton « actif » ne dit pas ce qu'on a demandé, il dit **où la salle en
 * est** : il suit la charge utile, pas le clic. C'est la règle du store
 * d'actions, et elle se voit ici — rien n'écrit dans l'état au clic.
 */
const props = defineProps<{
  commands: Command[]
  /** La valeur en vigueur, telle que le flux la rapporte. */
  current: string | null
  /** Ce qu'on poste pour une valeur donnée. */
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
