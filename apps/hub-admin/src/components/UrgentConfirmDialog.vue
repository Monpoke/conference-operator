<script setup lang="ts">
import { Button, ConfirmDialog } from '@conference-operator/components'
import { computed, ref, watch } from 'vue'

/**
 * An urgent message, confirmed by who sends it.
 *
 * Urgent takes over a room's screen, the live banner and the hall screen: a
 * console left open on a table must not be enough. The hub asks for the
 * `message:urgent` right and a fresh proof (see `urgent-proof.ts` on the hub):
 *
 * - **password** — typed again here, checked by the hub;
 * - **SSO, session too old** — "Se reconnecter" sends the operator through the
 *   provider and back; the parent keeps the draft across the round trip;
 * - **SSO, fresh session** — nothing to type, the confirmation is the click.
 */
const open = defineModel<boolean>('open', { required: true })

const props = defineProps<{
  /** How the hub wants the proof, or `null` while it is being asked. */
  proof: { method: 'password' | 'sso'; fresh: boolean } | null
  /** Where it goes and what it says, in a full sentence. */
  summary: string
  text: string
}>()

const emit = defineEmits<{ confirm: [password: string | undefined]; reauth: [] }>()

const password = ref('')
watch(open, (value) => {
  if (!value) password.value = ''
})

const needsReauth = computed(() => props.proof?.method === 'sso' && !props.proof.fresh)
const ready = computed(() => {
  if (props.proof == null || needsReauth.value) return false
  return props.proof.method === 'sso' || password.value.length > 0
})

function confirm(): void {
  emit('confirm', props.proof?.method === 'password' ? password.value : undefined)
}
</script>

<template>
  <ConfirmDialog
    v-model:open="open"
    title="⚠ Message urgent"
    tone="warn"
    danger
    confirm-label="Envoyer l'urgent"
    :confirm-disabled="!ready"
    :confirm-key="null"
    :cancel-key="null"
    @confirm="confirm"
  >
    <div class="rounded-lg border-2 border-alert bg-[color-mix(in_srgb,var(--color-alert)_12%,transparent)] p-3">
      <p class="text-sm font-semibold text-alert" data-role="urgent-summary">{{ summary }}</p>
      <p class="mt-2 rounded-lg border border-edge bg-canvas p-3 text-[15px] break-words">{{ text }}</p>
    </div>

    <p v-if="proof == null" class="mt-3 text-xs text-dim">Vérification du compte…</p>

    <template v-else-if="proof.method === 'password'">
      <label class="mt-3 block" for="urgent-password">Votre mot de passe, pour confirmer</label>
      <input
        id="urgent-password"
        v-model="password"
        type="password"
        autocomplete="current-password"
        class="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text"
        @keydown.enter.prevent="ready && confirm()"
      />
    </template>

    <template v-else-if="needsReauth">
      <p class="mt-3 text-xs text-dim">
        Compte connecté par SSO : un message urgent se confirme en vous reconnectant. Le message
        sera repris tel quel au retour.
      </p>
      <Button id="btn-urgent-reauth" variant="primary" class="mt-2 w-full" @click="emit('reauth')">
        Se reconnecter
      </Button>
    </template>

    <p v-else class="mt-3 text-xs text-dim">Connexion SSO récente : la confirmation suffit.</p>
  </ConfirmDialog>
</template>
