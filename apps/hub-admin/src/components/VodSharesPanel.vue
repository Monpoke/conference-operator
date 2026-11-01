<script setup lang="ts">
import { Button, Empty, Hint, Panel, useToast } from '@conference-operator/components'
import { MOT_DE_PASSE_PARTAGE_MIN } from '@conference-operator/contract'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref } from 'vue'
import { genererMotDePasse, usePartagesStore } from '../stores/partages.js'

/** The pages that open the edited videos to outsiders, each behind its password. */
const props = defineProps<{ talks: readonly { key: string; title: string }[] }>()
const store = usePartagesStore()
const { partages } = storeToRefs(store)
const toast = useToast()

onMounted(() => void store.load().catch(() => undefined))

const cible = ref('')
const motDePasse = ref('')
const busy = ref(false)
const valide = computed(() => motDePasse.value.length >= MOT_DE_PASSE_PARTAGE_MIN)

async function create(): Promise<void> {
  busy.value = true
  try {
    await store.create(cible.value === '' ? null : cible.value, motDePasse.value)
    toast.say('Page créée : notez le mot de passe, il ne sera plus affiché')
  } catch {
    /* already reported by the hub client */
  } finally {
    busy.value = false
  }
}

async function copy(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url)
    toast.say('Lien copié')
  } catch {
    toast.say('Copie refusée par le navigateur : sélectionnez le lien')
  }
}

async function remove(id: string): Promise<void> {
  if (!confirm('Retirer cette page ? Le lien cessera aussitôt de fonctionner.')) return
  await store.remove(id).catch(() => undefined)
}

const FIELD = 'rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text'
</script>

<template>
  <Panel id="vod-partages" title="Pages de partage" class="col-span-full">
    <div class="mb-3 flex flex-wrap items-end gap-2">
      <label class="flex min-w-0 flex-col gap-1 text-xs text-dim">
        Vidéos à montrer
        <select id="partage-cible" v-model="cible" :class="FIELD" class="max-w-full">
          <option value="">Toute l'édition</option>
          <option v-for="talk in props.talks" :key="talk.key" :value="talk.key">{{ talk.title }}</option>
        </select>
      </label>
      <label class="flex flex-col gap-1 text-xs text-dim">
        Mot de passe ({{ MOT_DE_PASSE_PARTAGE_MIN }} caractères au moins)
        <input id="partage-mot-de-passe" v-model="motDePasse" type="text" autocomplete="off" spellcheck="false" :class="FIELD" class="font-mono">
      </label>
      <Button id="btn-partage-generer" size="small" @click="motDePasse = genererMotDePasse()">Générer</Button>
      <Button id="btn-partage-creer" size="small" variant="primary" :disabled="!valide || busy" @click="create">Créer la page</Button>
    </div>
    <Empty v-if="partages.length === 0">Aucune page de partage.</Empty>
    <div v-for="partage in partages" :key="partage.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-edge py-2 text-sm" :data-partage="partage.id">
      <span class="min-w-0 flex-1 basis-60 font-medium">{{ partage.sessionId == null ? 'Toute l’édition' : partage.title ?? partage.sessionId }}</span>
      <a :href="partage.url" target="_blank" rel="noopener" class="min-w-0 font-mono text-xs break-all text-brand underline">{{ partage.url }}</a>
      <Button size="small" data-role="copier" @click="copy(partage.url)">Copier le lien</Button>
      <Button size="small" variant="danger" data-role="retirer" @click="remove(partage.id)">Retirer</Button>
    </div>
    <Hint class="mb-0">
      Le mot de passe n'est jamais conservé en clair : perdu, il faut retirer la page et en créer une autre. Les talks dont l'orateur a refusé la diffusion n'y apparaissent jamais.
    </Hint>
  </Panel>
</template>
