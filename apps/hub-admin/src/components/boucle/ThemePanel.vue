<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ThemeInfo } from '@conference-operator/contract'
import { Button, Panel, useToast } from '@conference-operator/components'
import { useDraft } from '../../composables/draft.js'
import { ImageRefused, useBoucleStore } from '../../stores/boucle.js'
import SaveBar from './SaveBar.vue'
import { LABEL } from './ui.js'

/**
 * The look the screens wear: the default theme, or a package imported here.
 *
 * A package is `theme.json` and its files, zipped (see `themes/cloudnord` and
 * `pnpm theme:pack`). The hub checks it whole on import; choosing it is a loop
 * setting like the others — saved, the rooms fetch it at their next sync and
 * their pages reload into it. The capture overlay and the VOD's intro and outro
 * wear it too.
 */
const store = useBoucleStore()
const toast = useToast()

const { draft, dirty, reset } = useDraft(() =>
  store.boucle == null ? null : { sha: store.boucle.theme?.sha ?? '' },
)

/** The one the screens wear now — never removable. */
const worn = computed(() => store.boucle?.theme?.sha ?? '')

const busy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} ko` : `${(bytes / 1024 / 1024).toFixed(1)} Mo`)
const date = (iso: string) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })

async function save(): Promise<void> {
  if (draft.value == null) return
  const chosen = store.themes.find((theme) => theme.sha === draft.value!.sha) ?? null
  try {
    await store.saveSections({ theme: chosen == null ? null : { id: chosen.id, nom: chosen.nom, sha: chosen.sha } })
    reset()
    toast.say(chosen == null ? 'Thème par défaut enregistré' : `Thème « ${chosen.nom} » enregistré`)
  } catch {
    /* already reported */
  }
}

async function pick(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file == null) return
  busy.value = true
  try {
    const info = await store.importTheme(file)
    // Imported to be worn, most of the time: chosen, left to save.
    if (draft.value != null) draft.value.sha = info.sha
    toast.say(`Thème « ${info.nom} » importé — enregistrez pour le porter`)
  } catch (cause) {
    // The hub's refusals are already reported by the client's hook.
    if (cause instanceof ImageRefused) toast.fail(cause.message)
  } finally {
    busy.value = false
    input.value = ''
  }
}

async function remove(theme: ThemeInfo): Promise<void> {
  try {
    await store.removeTheme(theme.sha)
    if (draft.value?.sha === theme.sha) draft.value.sha = worn.value
    toast.say(`Thème « ${theme.nom} » supprimé`)
  } catch {
    /* already reported */
  }
}
</script>

<template>
  <Panel title="Thème">
    <div v-if="draft != null" id="boucle-theme" class="flex flex-1 flex-col">
      <p :class="LABEL">Couleurs, polices et décor des écrans, de l'habillage de captation et des VOD</p>
      <div class="mb-[11px] flex flex-col gap-1.5" role="radiogroup">
        <label class="flex items-center gap-2 rounded-lg border border-edge px-2.5 py-2 text-sm">
          <input id="boucle-theme-defaut" v-model="draft.sha" type="radio" value="" class="w-auto" />
          <span class="min-w-0 flex-1">
            <span class="font-semibold">Par défaut</span>
            <span class="block text-xs text-dim">Sobre, intégré au code</span>
          </span>
        </label>
        <label
          v-for="theme in store.themes"
          :key="theme.sha"
          class="flex items-center gap-2 rounded-lg border border-edge px-2.5 py-2 text-sm"
          :data-theme="theme.id"
        >
          <input v-model="draft.sha" type="radio" :value="theme.sha" class="w-auto" />
          <span class="min-w-0 flex-1">
            <span class="font-semibold">{{ theme.nom }}</span>
            <span v-if="theme.sha === worn" class="ml-1.5 text-xs text-brand">sur les écrans</span>
            <span class="block truncate text-xs text-dim">
              v{{ theme.version }}<template v-if="theme.auteur"> · {{ theme.auteur }}</template> · {{ size(theme.taille) }} ·
              importé le {{ date(theme.importeLe) }}
            </span>
          </span>
          <a
            :href="`/boucle/theme/${theme.sha}.zip`"
            download
            class="text-xs text-dim underline hover:text-text"
            title="Télécharger le paquet, pour le modifier ou l'importer ailleurs"
          >Exporter</a>
          <Button
            v-if="theme.sha !== worn"
            size="small"
            variant="danger"
            title="Supprimer ce thème du hub"
            @click="remove(theme)"
          >×</Button>
        </label>
      </div>

      <input ref="fileInput" type="file" accept=".zip,application/zip" class="hidden" data-upload="boucle-theme" @change="pick" />
      <div class="mb-[11px]">
        <Button id="boucle-theme-importer" size="small" :disabled="busy" @click="fileInput?.click()">
          {{ busy ? 'Import…' : 'Importer un thème (.zip)' }}
        </Button>
      </div>

      <SaveBar id="boucle-theme-enregistrer" :dirty="dirty" @save="save" />
    </div>
  </Panel>
</template>
