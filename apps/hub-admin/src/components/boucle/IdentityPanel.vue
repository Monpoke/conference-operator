<script setup lang="ts">
import { Panel, useToast } from '@conference-operator/components'
import { useDraft } from '../../composables/draft.js'
import { useBoucleStore } from '../../stores/boucle.js'
import ImageField from './ImageField.vue'
import SaveBar from './SaveBar.vue'
import { FIELD, LABEL, SUBTITLE } from './ui.js'

/** What frames every scene: the logo, the welcome word, the signature, the band. */
const store = useBoucleStore()
const toast = useToast()

const { draft, dirty, reset } = useDraft(() =>
  store.boucle == null
    ? null
    : {
        logo: store.boucle.logo,
        accueil: store.boucle.accueil,
        signature: store.boucle.signature,
        barreBas: store.boucle.barreBas,
      },
)

function toggleSignature(on: boolean): void {
  if (draft.value == null) return
  draft.value.signature = on ? { texte: 'Cloud Nord', icone: 'linkedin' } : null
}

async function save(): Promise<void> {
  if (draft.value == null) return
  try {
    await store.saveSections(draft.value)
    reset()
    toast.say('Identité enregistrée')
  } catch {
    /* already reported */
  }
}
</script>

<template>
  <Panel title="Identité & bandeau">
    <div v-if="draft != null" id="boucle-identite" class="flex flex-1 flex-col">
      <ImageField id="boucle-logo" v-model="draft.logo" label="Logo" placeholder="Celui du programme" />

      <label :class="LABEL" for="boucle-accueil">Accueil — au-dessus du logo</label>
      <input id="boucle-accueil" v-model="draft.accueil.texte" maxlength="60" :class="FIELD" />

      <h3 :class="SUBTITLE">Signature</h3>
      <label class="mb-2 flex items-center gap-2 text-sm">
        <input
          id="boucle-signature-on"
          type="checkbox"
          class="w-auto"
          :checked="draft.signature != null"
          @change="toggleSignature(($event.target as HTMLInputElement).checked)"
        />
        En bas à droite de certaines scènes
      </label>
      <div v-if="draft.signature != null" class="mb-[11px] flex gap-1.5">
        <input
          id="boucle-signature-texte"
          v-model="draft.signature.texte"
          maxlength="40"
          :class="[FIELD, 'mb-0 flex-1']"
        />
        <select id="boucle-signature-icone" v-model="draft.signature.icone" :class="[FIELD, 'mb-0 w-auto']">
          <option value="linkedin">Icône LinkedIn</option>
          <option value="aucune">Sans icône</option>
        </select>
      </div>

      <h3 :class="SUBTITLE">Bandeau du bas</h3>
      <label class="mb-2 flex items-center gap-2 text-sm">
        <input id="boucle-barre-afficher" v-model="draft.barreBas.afficher" type="checkbox" class="w-auto" />
        Afficher le bandeau (session suivante, message, heure)
      </label>
      <label :class="LABEL" for="boucle-barre-libelle">Libellé de la session suivante</label>
      <input id="boucle-barre-libelle" v-model="draft.barreBas.libelle" maxlength="30" :class="FIELD" />
      <label :class="LABEL" for="boucle-barre-message">Message</label>
      <input id="boucle-barre-message" v-model="draft.barreBas.message" maxlength="60" :class="FIELD" />
      <label :class="LABEL" for="boucle-barre-hashtag">Hashtag</label>
      <input id="boucle-barre-hashtag" v-model="draft.barreBas.hashtag" maxlength="40" :class="FIELD" />
      <label :class="LABEL" for="boucle-barre-fin">En fin de journée</label>
      <input id="boucle-barre-fin" v-model="draft.barreBas.finJournee" maxlength="80" :class="FIELD" />

      <SaveBar id="btn-boucle-identite" :dirty="dirty" @save="save" />
    </div>
  </Panel>
</template>
