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
 * - **SSO, fresh session** — nothing to type, the confirmation is the click;
 * - otherwise, whatever the account allows: its **password**, typed again here,
 *   and/or **"Se reconnecter"** through the provider and back — the parent keeps
 *   the draft across the round trip.
 *
 * Both are offered to an account that has both: the one provisioned with a
 * password and later linked to Google signs in through Google, and may well not
 * know that password.
 */
const open = defineModel<boolean>('open', { required: true })

const props = defineProps<{
  /** How the hub wants the proof, or `null` while it is being asked. */
  proof: { password: boolean; sso: boolean; fresh: boolean } | null
  /** Where it goes and what it says, in a full sentence. */
  summary: string
  text: string
}>()

const emit = defineEmits<{ confirm: [password: string | undefined]; reauth: [] }>()

const password = ref('')
watch(open, (value) => {
  if (!value) password.value = ''
})

/** Signed in through the provider a moment ago: the session is the proof. */
const freshSso = computed(() => props.proof?.sso === true && props.proof.fresh)
const ready = computed(() => {
  if (props.proof == null) return false
  return freshSso.value || (props.proof.password && password.value.length > 0)
})

function confirm(): void {
  emit('confirm', !freshSso.value && password.value.length > 0 ? password.value : undefined)
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

    <p v-else-if="freshSso" class="mt-3 text-xs text-dim" data-role="urgent-fresh">
      Connexion SSO récente : la confirmation suffit.
    </p>

    <template v-else>
      <template v-if="proof.sso">
        <p class="mt-3 text-xs text-dim">
          Confirmez en vous reconnectant (SSO) : le message sera repris tel quel au retour.
        </p>
        <Button id="btn-urgent-reauth" variant="primary" class="mt-2 w-full" @click="emit('reauth')">
          Se reconnecter
        </Button>
      </template>
      <template v-if="proof.password">
        <label class="mt-3 block" for="urgent-password">
          {{ proof.sso ? 'Ou votre mot de passe du hub' : 'Votre mot de passe, pour confirmer' }}
        </label>
        <input
          id="urgent-password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          class="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text"
          @keydown.enter.prevent="ready && confirm()"
        />
      </template>
    </template>
  </ConfirmDialog>
</template>
