<script setup lang="ts">
import type { DisplayPayload } from '@conference-operator/contract'
import { Button, Panel } from '@conference-operator/components'
import { computed } from 'vue'
import { useActionsStore } from '../stores/actions.js'
import SimulatedBadge from './SimulatedBadge.vue'

/**
 * Both OBS instances' state, and the machine's log.
 *
 * "Régie en lecture seule" when the machine drives nothing: it is a real case — a
 * second window opened just to watch — and saying so beats two empty lines that
 * read as two disconnected OBS instances.
 */
const props = defineProps<{ payload: DisplayPayload }>()
const actions = useActionsStore()

const log = computed(() => props.payload.diagnostics?.log ?? [])

const instances = computed(() =>
  (['A', 'B'] as const).map((key) => {
    const obs = props.payload.diagnostics?.obs[key] ?? null
    return {
      key,
      connected: obs?.connected === true,
      simulated: obs?.simulated === true,
      // The capture in OBS-A's canvas: a single OBS in the room. Saying it here
      // spares the reading of "OBS B — déconnecté" as a second machine to go and
      // restart, when there is no second machine.
      canvas: obs?.canvas === true,
      scene: obs?.currentSceneName ?? 'scène inconnue',
      // A role that is configured but absent from OBS is visible nowhere else: the
      // switch will fail in the middle of a talk, with no other warning sign.
      missing: obs?.unresolvedRoles ?? [],
    }
  }),
)
</script>

<template>
  <Panel class="min-h-0 flex-1">
    <div class="mb-2.5 flex items-center gap-2">
      <h2 class="flex-1 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
        Diagnostic
      </h2>
      <!-- The effect is the answer: the lines disappear, a toast would add nothing. -->
      <Button
        v-if="log.length > 0"
        size="small"
        data-action="log.clear"
        @click="actions.act({ action: 'log.clear' }, { silent: true })"
      >
        Effacer le journal
      </Button>
    </div>

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
          OBS {{ instance.key }}{{ instance.canvas ? ' (canvas d’OBS A)' : '' }} —
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
      data-role="log"
    >
      <div
        v-for="(entry, index) in log"
        :key="index"
        :class="entry.level === 'warn' || entry.level === 'error' ? 'text-warn' : ''"
      >
        {{ entry.message }}
      </div>
    </div>
  </Panel>
</template>
