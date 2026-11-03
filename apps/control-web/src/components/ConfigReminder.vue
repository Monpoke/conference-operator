<script setup lang="ts">
import { Button } from '@conference-operator/components'
import { useConfigStore } from '../stores/config.js'

/**
 * What the room lacks without being stopped by it, said once at start-up.
 *
 * A strip rather than the configuration panel: the room is drivable, and the
 * operator decides when to look. It goes when closed, or by itself once the
 * list is empty.
 */
const config = useConfigStore()
</script>

<template>
  <div
    v-if="config.reminder && config.missing.length > 0"
    class="flex shrink-0 items-center gap-3 border-b border-warn/40 bg-surface px-3 py-1.5 text-sm text-warn"
    role="status"
    data-role="config-reminder"
  >
    <span class="min-w-0 flex-1">
      <strong class="font-semibold">Salle pas tout à fait prête :</strong>
      {{ config.missing.map((entry) => entry.text).join(' ') }}
    </span>
    <Button size="small" class="shrink-0" data-role="config-reminder-open" @click="config.show()">
      Configurer
    </Button>
    <Button
      variant="tab"
      size="small"
      class="shrink-0"
      aria-label="Masquer ce rappel"
      data-role="config-reminder-close"
      @click="config.reminder = false"
    >
      Masquer
    </Button>
  </div>
</template>
