<script setup lang="ts">
import { Button, Dialog } from '@conference-operator/components'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useConfirmStore } from '../stores/confirm.js'

const store = useConfirmStore()
const { request } = storeToRefs(store)
const open = computed({
  get: () => request.value != null,
  set: (value: boolean) => {
    if (!value) store.answer(false)
  },
})
</script>

<template>
  <Dialog v-model:open="open" :title="request?.title ?? ''">
    <p class="m-0 text-sm" data-role="confirm-message">{{ request?.message }}</p>
    <template #actions>
      <Button size="small" :variant="request?.danger ? 'danger' : 'primary'" data-role="confirm-oui" @click="store.answer(true)">{{ request?.confirmLabel }}</Button>
    </template>
  </Dialog>
</template>
