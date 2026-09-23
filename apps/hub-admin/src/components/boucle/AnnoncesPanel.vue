<script setup lang="ts">
import { MAX_ANNONCES } from '@conference-operator/contract'
import { Button, Empty, Panel, useToast } from '@conference-operator/components'
import { useDraft } from '../../composables/draft.js'
import { useBoucleStore } from '../../stores/boucle.js'
import ListControls from './ListControls.vue'
import SaveBar from './SaveBar.vue'
import SponsorPicker from './SponsorPicker.vue'
import { BOX, FIELD, LABEL } from './ui.js'

/** The "offered by" scenes: one per announcement — breakfast, lunch… */
const store = useBoucleStore()
const toast = useToast()
const MAX_LOGOS = 6

const { draft, dirty, reset } = useDraft(() => (store.boucle == null ? null : { annonces: store.boucle.annonces }))

function add(): void {
  draft.value?.annonces.push({ titre: '', sousTitre: 'offert par', logos: [] })
}

async function save(): Promise<void> {
  if (draft.value == null) return
  if (draft.value.annonces.some((annonce) => annonce.logos.some((logo) => logo.sponsor.trim() === ''))) {
    toast.fail('Choisissez un partenaire pour chaque logo, ou retirez-le')
    return
  }
  try {
    await store.save('annonces', draft.value.annonces)
    reset()
    toast.say('Annonces enregistrées')
  } catch {
    /* already reported */
  }
}
</script>

<template>
  <Panel title="Annonces « offert par »">
    <div v-if="draft != null" id="boucle-annonces" class="flex flex-1 flex-col">
      <Empty v-if="draft.annonces.length === 0">Aucune annonce : la boucle saute ces scènes.</Empty>
      <div v-for="(annonce, index) in draft.annonces" :key="index" :class="BOX" data-role="annonce">
        <div class="mb-1.5 flex items-center gap-1.5">
          <input
            :id="`boucle-annonce-${index}-titre`"
            v-model="annonce.titre"
            maxlength="80"
            placeholder="Petit déjeuner"
            :class="[FIELD, 'mb-0 min-w-0 flex-1']"
          />
          <ListControls :list="draft.annonces" :index="index" noun="l'annonce" />
        </div>
        <label :class="LABEL" :for="`boucle-annonce-${index}-sous-titre`">Sous-titre</label>
        <input
          :id="`boucle-annonce-${index}-sous-titre`"
          v-model="annonce.sousTitre"
          maxlength="80"
          :class="FIELD"
        />
        <div v-for="(_, logoIndex) in annonce.logos" :key="logoIndex" class="mb-2 flex items-start gap-1.5">
          <SponsorPicker
            :id="`boucle-annonce-${index}-logo-${logoIndex}`"
            v-model="annonce.logos[logoIndex]!"
            class="min-w-0 flex-1"
          />
          <ListControls :list="annonce.logos" :index="logoIndex" noun="le logo" />
        </div>
        <Button
          size="small"
          :disabled="annonce.logos.length >= MAX_LOGOS"
          @click="annonce.logos.push({ sponsor: '', nom: null, logo: null, echelle: 0.7 })"
        >
          Ajouter un logo
        </Button>
      </div>
      <SaveBar id="btn-boucle-annonces" :dirty="dirty" @save="save">
        <Button id="btn-boucle-annonce-add" size="small" :disabled="draft.annonces.length >= MAX_ANNONCES" @click="add">
          Ajouter une annonce
        </Button>
      </SaveBar>
    </div>
  </Panel>
</template>
