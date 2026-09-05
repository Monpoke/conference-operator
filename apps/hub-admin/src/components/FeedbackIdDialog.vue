<script setup lang="ts">
import { Button, Dialog, Hint, useToast } from '@conference-operator/components'
import { computed, ref, watch } from 'vue'
import { useConferencesStore, type PlannedSession } from '../stores/conferences.js'

/**
 * The OpenFeedback identifier served for one slot.
 *
 * The correction holds until it is removed, re-imports included, and reaches the
 * rooms: the projected QR code follows. Without it, the console and the room
 * screen would show two different addresses for the same talk.
 */
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ session: PlannedSession | null }>()

const store = useConferencesStore()
const toast = useToast()

const typed = ref('')
const error = ref('')

watch(
  () => props.session,
  (slot) => {
    typed.value = slot?.feedbackIdOverride ?? ''
    error.value = ''
  },
  { immediate: true },
)

/**
 * The address the QR code will serve, updated as one types.
 *
 * It is the only way to check a correction before saving it: the OpenFeedback page
 * is authoritative, not the export, and one recognises it by its address.
 */
const preview = computed(() => {
  const slot = props.session
  if (slot == null) return null
  if (slot.feedbackUrl == null) return null
  const id_ = typed.value.trim() === '' ? slot.id : typed.value.trim()
  const base = slot.feedbackUrl
  return base.slice(0, base.lastIndexOf('/') + 1) + encodeURIComponent(id_)
})

async function save(value_: string | null): Promise<void> {
  if (props.session == null) return
  error.value = ''
  try {
    await store.setFeedbackId(props.session.id, value_)
    toast.say(
      value_ == null ? "Créneau rendu à l'identifiant de l'export" : 'Identifiant OpenFeedback corrigé',
    )
    open.value = false
  } catch (cause) {
    // In the modal and not in the floating toast: the error is about what one
    // has just typed, and that is where it will be corrected.
    error.value = cause instanceof Error ? cause.message : "L'enregistrement a échoué."
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
      <label class="mb-[5px] block text-xs text-dim" for="feedback-field">
        Identifiant servi
      </label>
      <!--
        The placeholder is dimmed by hand: the theme's sheet does not tell it from
        a typed value, and here the two say the same thing — the export's id.
        Confused with each other, the field looks already filled in, and "Save"
        looks as if it lays down a correction that is not one.
      -->
      <input
        id="feedback-field"
        v-model="typed"
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

    <div id="feedback-preview" class="mt-2">
      <a
        v-if="preview != null"
        class="font-mono text-[11px] break-all text-brand"
        target="_blank"
        rel="noopener"
        :href="preview"
      >
        {{ preview }} ↗
      </a>
      <span v-else class="text-warn">
        Aucun projet OpenFeedback réglé : il n'y aura d'adresse pour personne tant que le champ
        des réglages est vide.
      </span>
    </div>

    <p v-if="error !== ''" id="feedback-error" class="mt-2 text-sm text-alert">{{ error }}</p>

    <Hint>
      La correction vaut jusqu'à ce qu'on la retire, réimports compris, et descend aux salles :
      le QR projeté suit, sans quoi la console et l'écran afficheraient deux adresses
      différentes pour le même talk.
    </Hint>

    <template #actions>
      <Button id="feedback-reset" size="small" @click="save(null)">
        Rendre à l'export
      </Button>
      <Button
        id="feedback-save"
        variant="primary"
        size="small"
        @click="save(typed.trim() === '' ? null : typed.trim())"
      >
        Enregistrer
      </Button>
    </template>
  </Dialog>
</template>
