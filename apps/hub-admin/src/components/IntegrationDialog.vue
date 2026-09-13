<script setup lang="ts">
import { Button, Dialog, Hint, Select, useToast } from '@conference-operator/components'
import { computed, ref, watch } from 'vue'
import {
  KIND_LABELS,
  useIntegrationsStore,
  type Integration,
  type IntegrationKind,
  type Level,
} from '../stores/integrations.js'

/**
 * Adds or edits an integration.
 *
 * On edit, the address and the secret start **empty**: the hub never gave them
 * back. Left empty they stay as they are; typed, they replace the old ones. The
 * type does not change — a Slack address means nothing to a webhook receiver.
 */
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ integration: Integration | null }>()

const store = useIntegrationsStore()
const toast = useToast()

const kind = ref<IntegrationKind>('slack')
const name = ref('')
const url = ref('')
const secret = ref('')
const removeSecret = ref(false)
const technique = ref<Level>('essentiel')
const exploitation = ref<Level>('essentiel')
const saving = ref(false)

watch(open, (isOpen) => {
  if (!isOpen) return
  const current = props.integration
  kind.value = current?.kind ?? 'slack'
  name.value = current?.name ?? ''
  url.value = ''
  secret.value = ''
  removeSecret.value = false
  technique.value = current?.levels.technique ?? 'essentiel'
  exploitation.value = current?.levels.exploitation ?? 'essentiel'
})

const editing = computed(() => props.integration != null)

const urlHelp = computed(() => {
  const keep = editing.value ? ` Vide : l'adresse actuelle (${props.integration!.url}) reste.` : ''
  switch (kind.value) {
    case 'slack':
      return `Slack › Apps › Incoming Webhooks — https://hooks.slack.com/services/…${keep}`
    case 'mattermost':
      return `Mattermost › Intégrations › Webhooks entrants — https://…/hooks/…${keep}`
    case 'webhook':
      return `Reçoit chaque avis en POST JSON.${keep}`
  }
})

const canSave = computed(
  () => name.value.trim() !== '' && (editing.value || url.value.trim() !== ''),
)

async function save(): Promise<void> {
  saving.value = true
  const levels = { technique: technique.value, exploitation: exploitation.value }
  const typedUrl = url.value.trim()
  try {
    if (props.integration == null) {
      await store.create({
        kind: kind.value,
        name: name.value.trim(),
        url: typedUrl,
        secret: kind.value === 'webhook' && secret.value !== '' ? secret.value : null,
        levels,
        enabled: true,
      })
      toast.say('Intégration ajoutée')
    } else {
      await store.update({
        id: props.integration.id,
        name: name.value.trim(),
        levels,
        ...(typedUrl === '' ? {} : { url: typedUrl }),
        ...(removeSecret.value ? { secret: null } : secret.value === '' ? {} : { secret: secret.value }),
      })
      toast.say('Intégration enregistrée')
    }
    open.value = false
  } catch {
    /* already reported */
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open" :title="editing ? `Modifier « ${integration!.name} »` : 'Nouvelle intégration'">
    <Select
      v-if="!editing"
      id="integration-kind"
      v-model="kind"
      label="Type"
      :options="[
        { value: 'slack', label: KIND_LABELS.slack },
        { value: 'mattermost', label: KIND_LABELS.mattermost },
        { value: 'webhook', label: 'Webhook JSON générique' },
      ]"
    />

    <div>
      <label class="mb-[5px] block text-xs text-dim" for="integration-name">Nom</label>
      <input
        id="integration-name"
        v-model="name"
        placeholder="#regie-technique"
        maxlength="80"
        class="w-full rounded-lg border border-edge bg-canvas px-2 py-1.5 text-sm text-text"
      />
    </div>

    <div>
      <label class="mb-[5px] block text-xs text-dim" for="integration-url">Adresse du webhook</label>
      <input
        id="integration-url"
        v-model="url"
        type="url"
        :placeholder="editing ? integration!.url : 'https://…'"
        class="w-full rounded-lg border border-edge bg-canvas px-2 py-1.5 text-sm text-text"
      />
      <Hint class="mt-1">{{ urlHelp }}</Hint>
    </div>

    <div v-if="kind === 'webhook'">
      <label class="mb-[5px] block text-xs text-dim" for="integration-secret">Secret de signature</label>
      <input
        id="integration-secret"
        v-model="secret"
        type="password"
        autocomplete="off"
        :disabled="removeSecret"
        :placeholder="integration?.hasSecret ? 'Secret enregistré — vide pour le garder' : 'Facultatif'"
        class="w-full rounded-lg border border-edge bg-canvas px-2 py-1.5 text-sm text-text"
      />
      <label v-if="integration?.hasSecret" class="mt-1 flex items-center gap-1.5 text-xs text-dim">
        <input id="integration-secret-remove" v-model="removeSecret" type="checkbox" />
        Retirer le secret
      </label>
      <Hint class="mt-1">
        Avec un secret, chaque envoi porte <code>X-Hub-Signature-256: sha256=…</code>, le HMAC-SHA256 du
        corps brut.
      </Hint>
    </div>

    <Select
      id="integration-technique"
      v-model="technique"
      label="Technique — les machines"
      :options="[
        { value: 'rien', label: 'Rien' },
        { value: 'essentiel', label: 'Une salle ne répond plus, un OBS coupé, une machine à appairer' },
        { value: 'tout', label: 'Tout, retours de salle et d’OBS compris' },
      ]"
    />
    <Select
      id="integration-exploitation"
      v-model="exploitation"
      label="Exploitation — le déroulé"
      :options="[
        { value: 'rien', label: 'Rien' },
        { value: 'essentiel', label: 'Dépassements et retards au démarrage' },
        { value: 'tout', label: 'Tout : débuts, fins, et fins dans cinq minutes' },
      ]"
    />

    <template #actions>
      <Button id="integration-save" variant="primary" size="small" :disabled="saving || !canSave" @click="save">
        {{ editing ? 'Enregistrer' : 'Ajouter' }}
      </Button>
    </template>
  </Dialog>
</template>
