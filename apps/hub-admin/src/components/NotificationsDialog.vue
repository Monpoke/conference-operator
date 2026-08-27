<script setup lang="ts">
import { Button, Dialog, Hint, Select, useToast } from '@cloudnord/components'
import { ref, watch } from 'vue'
import { useNotificationsStore, type Scope } from '../stores/notifications.js'

/**
 * Ce dont cet appareil-ci veut être prévenu.
 *
 * Deux familles réglées séparément, parce qu'elles n'intéressent pas les mêmes
 * personnes au même moment : les machines relèvent de qui tient la technique,
 * le déroulé de qui tient la journée. Et deux appareils du même opérateur — le
 * téléphone dans la poche, la console posée sur la table — ont deux réponses
 * légitimes, d'où un réglage local et non un réglage de compte.
 */
const open = defineModel<boolean>('open', { required: true })

const store = useNotificationsStore()
const toast = useToast()

const technique = ref<Scope>(store.levels.technique)
const exploitation = ref<Scope>(store.levels.exploitation)
const enCours = ref(false)

watch(open, (ouvert) => {
  if (!ouvert) return
  technique.value = store.levels.technique
  exploitation.value = store.levels.exploitation
})

/** Ce que le navigateur a déjà accordé, dit avant de demander quoi que ce soit. */
const portee = (): string =>
  typeof Notification !== 'undefined' && Notification.permission === 'granted'
    ? 'Cet appareil est autorisé à notifier.'
    : "Le navigateur demandera l'autorisation à la première application."

async function appliquer(): Promise<void> {
  enCours.value = true
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
    enCours.value = false
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
    <Hint id="notif-portee" class="mt-0">{{ portee() }}</Hint>

    <template #actions>
      <Button id="notif-appliquer" variant="primary" size="small" :disabled="enCours" @click="appliquer">
        Appliquer
      </Button>
    </template>
  </Dialog>
</template>
