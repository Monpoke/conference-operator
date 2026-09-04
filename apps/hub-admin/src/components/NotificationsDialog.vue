<script setup lang="ts">
import { Button, Dialog, Hint, Select, useToast } from '@cloudnord/components'
import { ref, watch } from 'vue'
import { useNotificationsStore, type Scope } from '../stores/notifications.js'

/**
 * What this device wants to be told about.
 *
 * Two families set separately, because they do not interest the same people at the
 * same moment: the machines are the concern of whoever holds the technical side,
 * the day's run of whoever holds the day. And two devices belonging to the same
 * operator — the phone in the pocket, the console on the table — have two
 * legitimate answers, hence a local setting and not an account setting.
 */
const open = defineModel<boolean>('open', { required: true })

const store = useNotificationsStore()
const toast = useToast()

const technique = ref<Scope>(store.levels.technique)
const exploitation = ref<Scope>(store.levels.exploitation)
const saving = ref(false)

watch(open, (isOpen) => {
  if (!isOpen) return
  technique.value = store.levels.technique
  exploitation.value = store.levels.exploitation
})

/** What the browser has already granted, said before asking for anything. */
const permissionNote = (): string =>
  typeof Notification !== 'undefined' && Notification.permission === 'granted'
    ? 'Cet appareil est autorisé à notifier.'
    : "Le navigateur demandera l'autorisation à la première application."

async function apply(): Promise<void> {
  saving.value = true
  try {
    const issue = await store.apply({
      technique: technique.value,
      exploitation: exploitation.value,
    })
    if (!issue.ok) {
      toast.fail(issue.message)
      return
    }
    open.value = false
    toast.say(
      issue.offline === true
        ? `${issue.message} — même console fermée, tant que le navigateur a Internet.`
        : issue.offline === false
          ? `${issue.message} — tant que la console reste ouverte.`
          : issue.message,
    )
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open" title="Notifications">
    <Select
      id="notif-technique"
      v-model="technique"
      label="Technique — les machines"
      :options="[
        { value: 'rien', label: 'Rien' },
        { value: 'essentiel', label: 'Une salle ne répond plus, une machine à appairer' },
        { value: 'tout', label: 'Tout, retours de salle compris' },
      ]"
    />
    <Select
      id="notif-exploitation"
      v-model="exploitation"
      label="Exploitation — le déroulé"
      :options="[
        { value: 'rien', label: 'Rien' },
        { value: 'essentiel', label: 'Dépassements et retards au démarrage' },
        { value: 'tout', label: 'Tout : débuts, fins, et fins dans cinq minutes' },
      ]"
    />
    <Hint id="notif-permissionNote" class="mt-0">{{ permissionNote() }}</Hint>

    <template #actions>
      <Button id="notif-apply" variant="primary" size="small" :disabled="saving" @click="apply">
        Appliquer
      </Button>
    </template>
  </Dialog>
</template>
