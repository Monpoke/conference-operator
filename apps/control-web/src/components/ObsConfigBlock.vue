<script setup lang="ts">
import type { VisibleConfig, ObsInstance, ObsState } from '@cloudnord/contract'
import { Button, Panel } from '@cloudnord/components'
import { computed } from 'vue'
import { ROLES, type ConfigDraft } from '../stores/config.js'
import SimulatedBadge from './SimulatedBadge.vue'

const props = defineProps<{
  instance: ObsInstance
  title: string
  draft: ConfigDraft
  config: VisibleConfig
  obs: ObsState | null
}>()

const emit = defineEmits<{ connect: [] }>()

const connected = computed(() => props.obs?.connected === true)
const missing = computed(() => (connected.value ? (props.obs?.unresolvedRoles ?? []) : []))
/*
 * The gap between what is saved and what is plugged in.
 *
 * Without saying so, a correct setting would stay without effect with nobody
 * seeing why: saving does not reconnect, it is up to the operator to choose when
 * to cut an instance.
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
    ? 'text-alert'
    : missing.value.length > 0 || pending.value
      ? 'text-warn'
      : 'text-ok',
)

/*
 * Reconnecting means cutting: never under a running take.
 *
 * A disconnected instance stays reconnectable, even if its last known state said
 * "recording" — that state is precisely the stale one.
 */
const taking = computed(() => connected.value && props.obs?.recording === true)

/**
 * The configured scene may not exist in OBS.
 *
 * That is in fact the defect being repaired here: we keep it in the list, named
 * for what it is, failing which opening the list would erase the offending setting
 * without showing it.
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
  'w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text focus:border-brand focus:outline-none'
</script>

<template>
  <Panel class="mb-3">
    <div class="mb-2 flex items-center gap-2">
      <h3 class="text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
        {{ title }}<SimulatedBadge :when="obs?.simulated === true" />
      </h3>
      <span class="flex-1 truncate text-xs" :class="tone" :data-state="instance">{{ status }}</span>
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
        <label class="mb-0.5 block text-xs text-dim" :for="`cfg-url-${instance}`">
          Adresse WebSocket
        </label>
        <input :id="`cfg-url-${instance}`" v-model="draft.obs[instance].url" :class="FIELD" />
      </div>
      <div>
        <label class="mb-0.5 block text-xs text-dim" :for="`cfg-pass-${instance}`">
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
          class="mt-1 flex items-center gap-1.5 text-[11px] text-dim"
        >
          <input v-model="draft.obs[instance].clearPassword" type="checkbox" />
          retirer le mot de passe
        </label>
      </div>
    </div>

    <div class="mt-2 grid grid-cols-3 gap-2">
      <div v-for="entry in ROLES[instance]" :key="entry.role">
        <label
          class="mb-0.5 block text-xs text-dim"
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
