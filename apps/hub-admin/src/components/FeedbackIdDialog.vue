<script setup lang="ts">
import { Button, Dialog, Hint, useToast } from '@cloudnord/components'
import { computed, ref, watch } from 'vue'
import { useConferencesStore, type PlannedSession } from '../stores/conferences.js'

/**
 * L'identifiant OpenFeedback servi pour un créneau.
 *
 * La correction vaut jusqu'à ce qu'on la retire, réimports compris, et descend
 * aux salles : le QR projeté suit. Sans cela, la console et l'écran de salle
 * afficheraient deux adresses différentes pour le même talk.
 */
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ session: PlannedSession | null }>()

const store = useConferencesStore()
const toast = useToast()

const saisie = ref('')
const erreur = ref('')

watch(
  () => props.session,
  (creneau) => {
    saisie.value = creneau?.feedbackIdOverride ?? ''
    erreur.value = ''
  },
  { immediate: true },
)

/**
 * L'adresse que servira le QR, mise à jour à la frappe.
 *
 * C'est la seule façon de vérifier une correction avant de l'enregistrer : la
 * page OpenFeedback fait foi, pas l'export, et on la reconnaît à son adresse.
 */
const apercu = computed(() => {
  const creneau = props.session
  if (creneau == null) return null
  if (creneau.feedbackUrl == null) return null
  const identifiant = saisie.value.trim() === '' ? creneau.id : saisie.value.trim()
  const base = creneau.feedbackUrl
  return base.slice(0, base.lastIndexOf('/') + 1) + encodeURIComponent(identifiant)
})

async function enregistrer(valeur: string | null): Promise<void> {
  if (props.session == null) return
  erreur.value = ''
  try {
    await store.setFeedbackId(props.session.id, valeur)
    toast.say(
      valeur == null ? "Créneau rendu à l'identifiant de l'export" : 'Identifiant OpenFeedback corrigé',
    )
    open.value = false
  } catch (cause) {
    // Dans la modale et non dans l'avis flottant : l'erreur porte sur ce qu'on
    // vient de taper, et c'est là qu'on va le corriger.
    erreur.value = cause instanceof Error ? cause.message : "L'enregistrement a échoué."
  }
}
</script>

<template>
  <Dialog
    v-model:open="open"
    :title="session?.title ?? 'Identifiant OpenFeedback'"
    width="wide"
  >
    <div class="mb-[11px]">
      <label class="mb-[5px] block text-xs text-dim" for="feedback-champ">
        Identifiant servi
      </label>
      <!--
        Le placeholder est atténué à la main : la feuille du thème ne le
        distingue pas d'une valeur saisie, et ici les deux disent la même chose
        — l'identifiant de l'export. Confondus, le champ paraît déjà rempli, et
        « Enregistrer » semble poser une correction qui n'en est pas une.
      -->
      <input
        id="feedback-champ"
        v-model="saisie"
        type="text"
        maxlength="200"
        autocomplete="off"
        :placeholder="session?.id"
        class="w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text placeholder:text-dim placeholder:italic focus:border-brand focus:outline-none"
      />
    </div>

    <Hint>
      Vide, c'est celui de l'export qui sert :
      <strong id="feedback-export" class="font-mono">{{ session?.id }}</strong>. Ne le corrigez
      que si la page OpenFeedback du talk porte un autre identifiant — c'est elle qui fait foi,
      pas l'export.
    </Hint>

    <div id="feedback-apercu" class="mt-2">
      <a
        v-if="apercu != null"
        class="font-mono text-[11px] break-all text-brand"
        target="_blank"
        rel="noopener"
        :href="apercu"
      >
        {{ apercu }} ↗
      </a>
      <span v-else class="text-warn">
        Aucun projet OpenFeedback réglé : il n'y aura d'adresse pour personne tant que le champ
        des réglages est vide.
      </span>
    </div>

    <p v-if="erreur !== ''" id="feedback-erreur" class="mt-2 text-sm text-alert">{{ erreur }}</p>

    <Hint>
      La correction vaut jusqu'à ce qu'on la retire, réimports compris, et descend aux salles :
      le QR projeté suit, sans quoi la console et l'écran afficheraient deux adresses
      différentes pour le même talk.
    </Hint>

    <template #actions>
      <Button id="feedback-rendre" size="small" @click="enregistrer(null)">
        Rendre à l'export
      </Button>
      <Button
        id="feedback-enregistrer"
        variant="primary"
        size="small"
        @click="enregistrer(saisie.trim() === '' ? null : saisie.trim())"
      >
        Enregistrer
      </Button>
    </template>
  </Dialog>
</template>
