<script setup lang="ts">
import type { VisibleConfig, ObsInstance, ObsState } from '@conference-operator/contract'
import { Button, Panel } from '@conference-operator/components'
import { computed, ref } from 'vue'
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

/**
 * Where the capture lives, chosen rather than deduced from a field left empty.
 *
 * The truth stays the address — empty means "no OBS-B, the capture rides in the
 * vertical canvas of OBS-A, which the plugin provides" — and this switch is the
 * gesture that writes it. A flag of its own could contradict the address; a
 * toggle over the address cannot.
 *
 * Only for the capture: the projection has no canvas to fall back on, and an
 * OBS-A without an address is a missing setting, not a second setup.
 */
const mode = computed<'obs-b' | 'canvas'>(() =>
  props.instance === 'B' && props.draft.obs.B.url.trim() === '' ? 'canvas' : 'obs-b',
)

/**
 * The address typed before switching to the plugin, kept aside.
 *
 * Switching modes is how one compares two setups; the round trip must not cost
 * the address of an OBS-B that is still plugged in. Restored as typed, nothing
 * more — it is a draft, it only lives as long as the panel is open.
 */
const parked = ref('')

function choose(next: 'obs-b' | 'canvas'): void {
  if (next === mode.value) return
  const endpoint = props.draft.obs[props.instance]
  if (next === 'canvas') {
    parked.value = endpoint.url
    endpoint.url = ''
  } else {
    endpoint.url = parked.value
  }
}

const connected = computed(() => props.obs?.connected === true)
/**
 * The capture lives in OBS-A's vertical canvas: the room runs on a single OBS.
 *
 * Said by the machine and not deduced from the empty field: what is on screen is
 * the state of the capture that exists, not the absence of one that is being
 * typed — the field is empty as well while an address is being erased.
 */
const canvas = computed(() => props.obs?.canvas === true)
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
  const where = canvas.value ? "canvas vertical d'OBS-A · " : ''
  const head = !connected.value
    ? 'déconnecté'
    : missing.value.length > 0
      ? `connecté · rôles absents : ${missing.value.join(', ')}`
      : `connecté · ${props.obs?.currentSceneName ?? 'scène inconnue'}`
  return where + head + (pending.value ? ' · réglages non appliqués' : '')
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

const MODES: { value: 'obs-b' | 'canvas'; label: string }[] = [
  { value: 'obs-b', label: 'OBS-B dédié' },
  { value: 'canvas', label: "Canvas vertical d'OBS-A" },
]

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

    <!--
      Le choix avant les champs qu'il commande.

      Deux façons de capter, et une seule à la fois : lues côte à côte, elles
      disent ce que la salle exige — un second OBS, ou le plugin dans celui de la
      projection. Le panneau n'affiche ensuite que les champs du mode retenu.
    -->
    <div v-if="instance === 'B'" class="mb-2" role="radiogroup" aria-label="Où vit la captation">
      <div class="inline-flex rounded-lg border border-edge p-0.5">
        <button
          v-for="choice in MODES"
          :key="choice.value"
          type="button"
          role="radio"
          :aria-checked="mode === choice.value"
          :data-mode="choice.value"
          :data-active="mode === choice.value ? 'true' : undefined"
          class="rounded-md px-2.5 py-1 text-xs"
          :class="mode === choice.value ? 'bg-brand text-canvas' : 'text-dim hover:text-text'"
          @click="choose(choice.value)"
        >
          {{ choice.label }}
        </button>
      </div>
      <p class="mt-1 text-[11px] text-dim">
        {{
          mode === 'canvas'
            ? "Un seul OBS dans la salle : la captation passe par le canvas vertical d'OBS-A, que le plugin fournit. Sans le plugin, rien n'enregistre."
            : 'Un second OBS, sur cette machine ou sur une autre, dédié à la captation.'
        }}
      </p>
    </div>

    <div v-if="mode === 'obs-b'" class="grid grid-cols-2 gap-2">
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
