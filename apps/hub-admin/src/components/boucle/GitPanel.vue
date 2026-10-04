<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Button, Panel, useToast } from '@conference-operator/components'
import { useBoucleStore } from '../../stores/boucle.js'
import { FIELD, LABEL, SUBTITLE } from './ui.js'

/**
 * A Git repository the loop is imported from: one folder of one branch, holding
 * a theme (`theme.json` and its files), the loop's content (`boucle.json`), or
 * both. An import, on demand — never a synchronisation: what comes in is the
 * hub's from then on, still edited in the panels, until the next import
 * overwrites what its file names.
 */
const store = useBoucleStore()
const toast = useToast()

const url = ref('')
const branche = ref('main')
const dossier = ref('')
/** Typed here: a new token. Empty: the hub keeps its own. */
const jeton = ref('')
const busy = ref<'source' | 'theme' | 'contenu' | null>(null)

// The form follows the hub until it is touched, like the other panels.
const touched = ref(false)
watch(
  () => store.gitSource,
  (source) => {
    if (touched.value) return
    url.value = source?.url ?? ''
    branche.value = source?.branche ?? 'main'
    dossier.value = source?.dossier ?? ''
  },
  { immediate: true },
)

const derniere = computed(() => store.gitSource?.derniere ?? null)
const when = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

async function saveSource(): Promise<void> {
  busy.value = 'source'
  try {
    const cleared = url.value.trim() === ''
    await store.setGitSource(
      cleared ? null : { url: url.value.trim(), branche: branche.value.trim() || 'main', dossier: dossier.value.trim().replace(/^\/+|\/+$/g, '') },
      jeton.value.trim() === '' ? undefined : jeton.value.trim(),
    )
    jeton.value = ''
    touched.value = false
    toast.say(cleared ? 'Dépôt Git retiré' : 'Dépôt Git enregistré')
  } catch {
    /* already reported */
  } finally {
    busy.value = null
  }
}

async function forgetToken(): Promise<void> {
  const source = store.gitSource
  if (source == null) return
  try {
    await store.setGitSource({ url: source.url, branche: source.branche, dossier: source.dossier }, null)
    toast.say('Jeton retiré')
  } catch {
    /* already reported */
  }
}

async function importer(what: 'theme' | 'contenu'): Promise<void> {
  busy.value = what
  try {
    const result = await store.importGit({ theme: what === 'theme', contenu: what === 'contenu' })
    const commit = result.commit?.slice(0, 7) ?? '?'
    if (what === 'theme') {
      toast.say(result.porte ? `Thème importé et mis sur les écrans (${commit})` : `Thème déjà sur les écrans, inchangé (${commit})`)
    } else {
      toast.say(`Contenu importé (${commit}) : ${result.sections?.length ?? 0} section(s)`)
    }
  } catch {
    /* already reported — and shown below */
  } finally {
    busy.value = null
  }
}

</script>

<template>
  <Panel title="Dépôt Git">
    <div id="boucle-git" class="flex flex-1 flex-col">
      <p :class="LABEL">
        Un dossier d'une branche : <code>theme.json</code> et ses fichiers, <code>boucle.json</code> pour le contenu, ou
        les deux. Importé à la demande.
      </p>

      <label :class="LABEL" for="boucle-git-url">Adresse du dépôt (https)</label>
      <input
        id="boucle-git-url"
        v-model="url"
        type="url"
        placeholder="https://github.com/organisation/habillage.git"
        :class="FIELD"
        @input="touched = true"
      />
      <div class="flex gap-1.5">
        <div class="min-w-0 flex-1">
          <label :class="LABEL" for="boucle-git-branche">Branche</label>
          <input id="boucle-git-branche" v-model="branche" :class="FIELD" @input="touched = true" />
        </div>
        <div class="min-w-0 flex-1">
          <label :class="LABEL" for="boucle-git-dossier">Sous-dossier</label>
          <input id="boucle-git-dossier" v-model="dossier" placeholder="Racine" :class="FIELD" @input="touched = true" />
        </div>
      </div>
      <label :class="LABEL" for="boucle-git-jeton">Jeton d'accès (dépôt privé)</label>
      <div class="mb-[11px] flex items-center gap-1.5">
        <input
          id="boucle-git-jeton"
          v-model="jeton"
          type="password"
          autocomplete="off"
          :placeholder="store.gitSource?.jetonDefini ? `Gardé sur le hub (…${store.gitSource.jetonIndice ?? ''})` : 'Aucun — dépôt public'"
          :class="[FIELD, 'mb-0 min-w-0 flex-1']"
          @input="touched = true"
        />
        <Button v-if="store.gitSource?.jetonDefini" size="small" variant="danger" title="Retirer le jeton" @click="forgetToken">×</Button>
      </div>
      <div class="mb-[11px]">
        <Button id="boucle-git-enregistrer" size="small" variant="primary" :disabled="busy != null" @click="saveSource">
          {{ busy === 'source' ? '…' : 'Enregistrer le dépôt' }}
        </Button>
      </div>

      <template v-if="store.gitSource != null">
        <h3 :class="SUBTITLE">Importer</h3>
        <div class="mb-1.5 flex flex-wrap gap-1.5">
          <Button id="boucle-git-theme" size="small" :disabled="busy != null || touched" @click="importer('theme')">
            {{ busy === 'theme' ? 'Import…' : 'Le thème' }}
          </Button>
          <Button id="boucle-git-contenu" size="small" :disabled="busy != null || touched" @click="importer('contenu')">
            {{ busy === 'contenu' ? 'Import…' : 'Le contenu de la boucle' }}
          </Button>
        </div>
        <p class="mb-[11px] text-xs text-dim">
          Le thème importé devient celui des écrans. Le contenu remplace les sections que nomme
          <code>boucle.json</code> ; les autres restent telles quelles.
        </p>

        <p v-if="derniere != null" id="boucle-git-derniere" class="mb-[11px] text-xs" :class="derniere.erreur ? 'text-alert' : 'text-dim'">
          Dernier import le {{ when(derniere.le) }}<template v-if="derniere.commit"> · commit {{ derniere.commit.slice(0, 7) }}</template>
          <template v-if="derniere.erreur"><br /><span class="whitespace-pre-line">{{ derniere.erreur }}</span></template>
          <template v-else-if="derniere.sections"> · {{ derniere.sections.join(', ') || 'aucune section' }}</template>
          <template v-else-if="derniere.theme"> · thème importé</template>
        </p>
      </template>

      <!--
        The whole configuration as the hub holds it — boucle.json, the images
        dropped here, the theme worn — to unzip into the repository's folder and
        commit: the save, and the start of a repository. A link: the hub builds it.
      -->
      <div class="mt-auto pt-2">
        <a
          id="boucle-git-exporter"
          href="/boucle/export.zip"
          download
          class="inline-flex items-center rounded-md border border-edge px-2.5 py-1 text-xs text-text no-underline hover:border-brand"
          title="Contenu, images déposées et thème : à décompresser dans le dossier du dépôt, puis à committer"
        >Exporter la configuration (.zip)</a>
        <p class="mt-1 text-[11px] text-dim">
          Pour sauvegarder dans le dépôt ce qui a été modifié ici : à décompresser dans le sous-dossier, puis à committer.
        </p>
      </div>
    </div>
  </Panel>
</template>
