<script setup lang="ts">
import type { DisplayPayload } from '@cloudnord/contract'
import { Panel } from '@cloudnord/components'
import { computed } from 'vue'
import SimulatedBadge from './SimulatedBadge.vue'

/**
 * L'état des deux OBS, et le journal du poste.
 *
 * « Régie en lecture seule » quand le poste ne pilote rien : c'est un cas réel —
 * une deuxième fenêtre ouverte pour regarder — et le dire vaut mieux que deux
 * lignes vides qui se lisent comme deux OBS déconnectés.
 */
const props = defineProps<{ payload: DisplayPayload }>()

const instances = computed(() =>
  (['A', 'B'] as const).map((key) => {
    const obs = props.payload.diagnostics?.obs[key] ?? null
    return {
      key,
      connected: obs?.connected === true,
      simulated: obs?.simulated === true,
      scene: obs?.currentSceneName ?? 'scène inconnue',
      // Un rôle configuré mais absent d'OBS ne se voit nulle part ailleurs : la
      // bascule échouera au milieu d'un talk, sans autre signe avant-coureur.
      missing: obs?.unresolvedRoles ?? [],
    }
  }),
)
</script>

<template>
  <Panel class="min-h-0 flex-1">
    <h2 class="mb-2.5 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
      Diagnostic
    </h2>

    <div v-if="payload.diagnostics == null" class="flex items-center gap-2 text-xs">
      Régie en lecture seule
    </div>
    <div v-else class="flex flex-col gap-1 text-xs">
      <div
        v-for="instance in instances"
        :key="instance.key"
        class="flex items-center gap-2"
        :data-obs="instance.key"
      >
        <span class="status-dot" :class="instance.connected ? '' : 'offline'"></span>
        <span class="truncate">
          OBS {{ instance.key }} —
          {{ instance.connected ? instance.scene : 'déconnecté' }}
        </span>
        <SimulatedBadge :when="instance.simulated" />
        <span v-if="instance.missing.length > 0" class="ml-auto shrink-0 text-warn">
          rôles absents : {{ instance.missing.join(', ') }}
        </span>
      </div>
    </div>

    <div
      class="mt-1.5 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto text-[11px] text-dim"
      data-role="journal"
    >
      <div
        v-for="(entry, index) in payload.diagnostics?.log ?? []"
        :key="index"
        :class="entry.level === 'warn' || entry.level === 'error' ? 'text-warn' : ''"
      >
        {{ entry.message }}
      </div>
    </div>
  </Panel>
</template>
