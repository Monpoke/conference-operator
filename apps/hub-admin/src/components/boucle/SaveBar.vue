<script setup lang="ts">
import { Button } from '@conference-operator/components'

/**
 * A panel's "Enregistrer", and whether there is anything to save.
 *
 * Said in words: a panel left with unsaved changes no longer follows the hub,
 * and the operator must know why it does not move.
 */
defineProps<{ id: string; dirty: boolean }>()
defineEmits<{ save: [] }>()
</script>

<template>
  <div class="mt-auto flex items-center gap-2 pt-2">
    <Button :id="id" variant="primary" size="small" @click="$emit('save')">Enregistrer</Button>
    <span v-if="dirty" class="text-xs text-warn" data-role="dirty">Modifications non enregistrées</span>
    <slot />
  </div>
</template>
