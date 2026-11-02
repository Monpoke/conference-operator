<script setup lang="ts">
import { Badge, Button, ConfirmDialog, Empty, Hint, Panel, StableLabel, useToast } from '@conference-operator/components'
import { storeToRefs } from 'pinia'
import { ref } from 'vue'
import IntegrationDialog from '../IntegrationDialog.vue'
import { useConfirmStore } from '../../stores/confirm.js'
import { KIND_LABELS, deliveryStatus, useIntegrationsStore, type Integration } from '../../stores/integrations.js'
import { useSauvegardeStore, type RestaurationReport } from '../../stores/sauvegarde.js'
import { useSettingsStore } from '../../stores/settings.js'

/**
 * Réglages, Système: who gets the notices, and how to start again on a new hub.
 *
 * Mounted with its siblings and only hidden: a draft survives a change of section.
 */
const store = useSettingsStore()
const confirmStore = useConfirmStore()
const toast = useToast()

// — Integrations —
const integrationsStore = useIntegrationsStore()
const { integrations } = storeToRefs(integrationsStore)
const integrationDialog = ref(false)
const editedIntegration = ref<Integration | null>(null)
const integrationToRemove = ref<Integration | null>(null)
const removeConfirmation = ref(false)
const testing = ref<string | null>(null)

function openIntegration(item: Integration | null): void {
  editedIntegration.value = item
  integrationDialog.value = true
}

async function toggleIntegration(item: Integration): Promise<void> {
  try {
    await integrationsStore.update({ id: item.id, enabled: !item.enabled })
    toast.say(item.enabled ? `« ${item.name} » désactivée` : `« ${item.name} » activée`)
  } catch {
    /* already reported */
  }
}

/**
 * The other end's answer, word for word.
 *
 * "Échec" alone sends the operator to the logs; `invalid_token` or
 * `channel_not_found` tells them which setting to fix in Slack.
 */
async function testIntegration(item: Integration): Promise<void> {
  testing.value = item.id
  try {
    const result = await integrationsStore.test(item.id)
    if (result.ok) toast.say(`« ${item.name} » a reçu l'avis de test`)
    else toast.fail(`« ${item.name} » : ${result.error ?? 'échec'}`)
  } catch {
    /* already reported */
  } finally {
    testing.value = null
  }
}

function askRemoveIntegration(item: Integration): void {
  integrationToRemove.value = item
  removeConfirmation.value = true
}

async function confirmRemoveIntegration(): Promise<void> {
  const item = integrationToRemove.value
  if (item == null) return
  try {
    await integrationsStore.remove(item.id)
    toast.say(`« ${item.name} » supprimée`)
  } catch {
    /* already reported */
  }
}

// — Backup —
const sauvegarde = useSauvegardeStore()
const restoring = ref(false)
const restored = ref<RestaurationReport | null>(null)

async function restoreBackup(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file == null) return
  if (!(await confirmStore.ask({ title: 'Restaurer cette sauvegarde ?', message: `Restaurer « ${file.name} » sur ce hub ? Les réglages, salles, programme, posts de la console et comptes de la sauvegarde remplacent ceux qui portent le même nom ici.`, confirmLabel: 'Restaurer', danger: true }))) return
  restoring.value = true
  try {
    restored.value = await sauvegarde.restore(file)
    toast.say('Sauvegarde restaurée')
    await store.load()
  } catch (cause) {
    toast.fail((cause as Error).message)
  } finally {
    restoring.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-3.5">
    <Panel title="Intégrations">
      <div id="integrations">
        <Empty v-if="integrations.length === 0">
          Aucune intégration. Les avis ne partent que vers les consoles abonnées.
        </Empty>
        <div
          v-for="item in integrations"
          :key="item.id"
          class="mb-2 border-b border-edge pb-2 last:mb-0 last:border-b-0"
        >
          <div class="flex items-center gap-2">
            <Badge :variant="item.enabled ? 'running' : 'neutral'">{{ KIND_LABELS[item.kind] }}</Badge>
            <strong class="min-w-0 flex-1 truncate text-sm text-text">{{ item.name }}</strong>
            <label class="flex items-center gap-1 text-xs text-dim">
              <input
                :id="`integration-enabled-${item.id}`"
                type="checkbox"
                :checked="item.enabled"
                @change="toggleIntegration(item)"
              />
              Active
            </label>
          </div>
          <p class="mt-0.5 truncate text-xs text-dim" :title="item.url">
            {{ item.url }} · technique : {{ item.levels.technique }} · exploitation :
            {{ item.levels.exploitation }}
          </p>
          <p
            v-if="deliveryStatus(item) != null"
            class="mt-0.5 text-xs"
            :class="deliveryStatus(item)!.ok ? 'text-dim' : 'text-alert'"
          >
            {{ deliveryStatus(item)!.text }}
          </p>
          <div class="mt-1.5 flex gap-1.5">
            <Button size="small" :disabled="testing === item.id" @click="testIntegration(item)">
              <StableLabel :current="testing === item.id ? 'Envoi…' : 'Tester'" :labels="['Envoi…', 'Tester']" />
            </Button>
            <Button size="small" @click="openIntegration(item)">Modifier</Button>
            <Button variant="danger" size="small" @click="askRemoveIntegration(item)">Supprimer</Button>
          </div>
        </div>
      </div>
      <div class="mt-2 flex gap-1.5">
        <Button id="btn-integration-add" size="small" @click="openIntegration(null)">
          Ajouter une intégration
        </Button>
      </div>
      <Hint class="mt-2">
        Slack, Mattermost ou webhook JSON : les mêmes avis que les notifications, filtrés par famille.
      </Hint>
    </Panel>

    <Panel title="Sauvegarde de la configuration">
      <p class="mb-2 text-[13px] text-dim">
        Tout ce qu'il faut pour repartir sur un hub neuf : réglages et boucle, salles, programme et ses
        corrections, posts écrits ou mis en avant dans la console, comptes opérateurs, images et thèmes.
        Pas les données du jour (statistiques, journaux, messages du public) ni les appairages des machines.
        Le fichier contient les empreintes des mots de passe : gardez-le comme un secret.
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <a
          id="btn-sauvegarde-export"
          href="/sauvegarde/export.json"
          download
          class="inline-flex items-center rounded-md border border-edge px-2.5 py-1 text-xs text-text no-underline hover:border-brand"
        >Télécharger la sauvegarde</a>
        <label
          for="sauvegarde-fichier"
          class="inline-flex cursor-pointer items-center rounded-md border border-edge px-2.5 py-1 text-xs text-text hover:border-brand"
          :class="restoring ? 'pointer-events-none opacity-50' : ''"
        >{{ restoring ? 'Restauration…' : 'Restaurer une sauvegarde…' }}</label>
        <input id="sauvegarde-fichier" type="file" accept="application/json,.json" class="hidden" @change="restoreBackup" />
      </div>
      <div v-if="restored" id="sauvegarde-rapport" class="mt-3 text-[13px] text-dim">
        <p>
          Restauré : {{ Object.values(restored.lignes).reduce((a, b) => a + b, 0) }} éléments,
          {{ restored.fichiers.images }} image(s), {{ restored.fichiers.themes }} fichier(s) de thème.
        </p>
        <p v-if="restored.comptesIgnores.length">
          Comptes déjà présents, gardés tels quels : {{ restored.comptesIgnores.join(', ') }}.
        </p>
        <div v-if="restored.aRessaisir.length" class="text-alert">
          À ressaisir (chiffrés avec la clé de l'ancien hub) :
          <ul class="ml-4 list-disc">
            <li v-for="item in restored.aRessaisir" :key="item">{{ item }}</li>
          </ul>
        </div>
      </div>
    </Panel>

    <IntegrationDialog v-model:open="integrationDialog" :integration="editedIntegration" />

    <ConfirmDialog
      v-model:open="removeConfirmation"
      title="Supprimer l'intégration"
      confirm-label="Supprimer"
      @confirm="confirmRemoveIntegration"
    >
      Plus aucun avis ne partira vers <strong>{{ integrationToRemove?.name }}</strong>.
    </ConfirmDialog>
  </div>
</template>
