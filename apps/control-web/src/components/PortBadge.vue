<script setup lang="ts">
import { computed } from 'vue'

/**
 * The room serves on a port other than the one it wanted.
 *
 * Shown only in that case, like the mode and protocol badges beside it: a room on
 * its usual port must carry nothing, or the badge becomes furniture nobody reads
 * any more.
 *
 * It is here rather than in the notice stack because it does not expire. A notice
 * lasts thirty seconds — right for a fact one catches on the fly, wrong for a
 * condition that holds for the whole day and explains, three hours later, why the
 * projection has been black since this morning: OBS's Browser Sources carry the
 * port in hard, so a room that has moved projects for nobody while looking
 * perfectly healthy.
 *
 * The tooltip names the gesture, because the badge alone would only worry. Fixing
 * it is either in OBS — the Browser Sources' address field — or by freeing the
 * wanted port and restarting the room.
 */
const props = defineProps<{ port: { wanted: number; actual: number } | null }>()

const moved = computed(() => props.port != null && props.port.actual !== props.port.wanted)
</script>

<template>
  <span v-if="moved" class="shrink-0">
    <span
      data-role="port-fallback"
      class="rounded border border-warn/50 px-1.5 py-px text-[10px] font-semibold tracking-[.08em] text-warn uppercase"
      :title="`Le port ${port?.wanted} était occupé au démarrage : cette salle sert sur ${port?.actual}. Les sources navigateur d'OBS réglées sur ${port?.wanted} n'affichent pas cette salle — corrigez leur adresse, ou libérez le port ${port?.wanted} et relancez la salle.`"
    >
      port {{ port?.actual }} · {{ port?.wanted }} occupé
    </span>
  </span>
</template>
