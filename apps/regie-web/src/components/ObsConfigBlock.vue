<script setup lang="ts">
import type { ConfigVisible, ObsInstance, ObsState } from '@cloudnord/contract'
import { Button, Panel } from '@cloudnord/components'
import { computed } from 'vue'
import { ROLES, type ConfigDraft } from '../stores/config.js'
import SimulatedBadge from './SimulatedBadge.vue'

const props = defineProps<{
  instance: ObsInstance
  title: string
  draft: ConfigDraft
  config: ConfigVisible
  obs: ObsState | null
}>()

const emit = defineEmits<{ connect: [] }>()

const connected = computed(() => props.obs?.connected === true)
const missing = computed(() => (connected.value ? (props.obs?.unresolvedRoles ?? []) : []))
/*
 * L'écart entre ce qui est enregistré et ce qui est branché.
 *
 * Sans le dire, un réglage juste resterait sans effet sans que personne ne voie
 * pourquoi : enregistrer ne reconnecte pas, c'est à l'opérateur de choisir
 * quand couper une instance.
 */
const pending = computed(() => props.config.obs[props.instance].pending)

const status = computed(() => {
  const head = !connected.value
    ? 'déconnecté'
    : missing.value.length > 0
      ? `connecté · rôles absents : ${missing.value.join(', ')}`
      : `connecté · ${props.obs?.currentSceneName ?? 'scène inconnue'}`
  return head + (pending.value ? ' · réglages non appliqués' : '')
})

const tone = computed(() =>
  !connected.value
    ? 'text-alerte'
    : missing.value.length > 0 || pending.value
      ? 'text-attention'
      : 'text-ok',
)

/*
 * Reconnecter, c'est couper : jamais sous une prise en cours.
 *
 * Une instance déconnectée reste reconnectable, même si son dernier état connu
 * disait « enregistre » — il est justement périmé.
 */
const taking = computed(() => connected.value && props.obs?.recording === true)

/**
 * La scène configurée peut ne pas exister dans OBS.
 *
 * C'est même le défaut qu'on vient réparer ici : on la garde dans la liste,
 * dite pour ce qu'elle est, faute de quoi l'ouvrir effacerait le réglage fautif
 * sans le montrer.
 */
function options(current: string): { value: string; label: string }[] {
  const scenes = props.obs?.scenes ?? []
  const list = [{ value: '', label: '— non configuré —' }]
  for (const name of scenes) list.push({ value: name, label: name })
  if (current !== '' && !scenes.includes(current)) {
    list.push({ value: current, label: `${current} — absente d'OBS` })
  }
  return list
}

const FIELD =
  'w-full rounded-lg border border-bord bg-fond px-3 py-2 text-sm text-texte focus:border-marque focus:outline-none'
</script>

<template>
  <Panel class="mb-3">
    <div class="mb-2 flex items-center gap-2">
      <h3 class="text-[11px] font-semibold tracking-[.14em] text-attenue uppercase">
        {{ title }}<SimulatedBadge :when="obs?.simulated === true" />
      </h3>
      <span class="flex-1 truncate text-xs" :class="tone" :data-etat="instance">{{ status }}</span>
      <Button
        size="small"
        class="shrink-0"
        :disabled="taking"
        :data-connect="instance"
        :title="
          taking
            ? 'Enregistrement en cours sur cette instance : l’arrêter avant de reconnecter'
            : 'Applique les réglages ci-dessus à cette instance'
        "
        @click="emit('connect')"
      >
        {{ connected ? 'Reconnecter' : 'Connecter' }}
      </Button>
    </div>

    <div class="grid grid-cols-2 gap-2">
      <div>
        <label class="mb-0.5 block text-xs text-attenue" :for="`cfg-url-${instance}`">
          Adresse WebSocket
        </label>
        <input :id="`cfg-url-${instance}`" v-model="draft.obs[instance].url" :class="FIELD" />
      </div>
      <div>
        <label class="mb-0.5 block text-xs text-attenue" :for="`cfg-pass-${instance}`">
          Mot de passe
        </label>
        <input
          :id="`cfg-pass-${instance}`"
          v-model="draft.obs[instance].password"
          type="password"
          :class="FIELD"
          :placeholder="config.obs[instance].hasPassword ? 'inchangé' : 'aucun'"
        />
        <label
          v-if="config.obs[instance].hasPassword"
          class="mt-1 flex items-center gap-1.5 text-[11px] text-attenue"
        >
          <input v-model="draft.obs[instance].clearPassword" type="checkbox" />
          retirer le mot de passe
        </label>
      </div>
    </div>

    <div class="mt-2 grid grid-cols-3 gap-2">
      <div v-for="entry in ROLES[instance]" :key="entry.role">
        <label
          class="mb-0.5 block text-xs text-attenue"
          :for="`cfg-role-${instance}-${entry.role}`"
        >
          {{ entry.role }} · {{ entry.label }}
        </label>
        <select
          :id="`cfg-role-${instance}-${entry.role}`"
          v-model="draft.sceneRoles[instance][entry.role]"
          :class="FIELD"
        >
          <option
            v-for="option in options(draft.sceneRoles[instance][entry.role] ?? '')"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
      </div>
    </div>
  </Panel>
</template>
