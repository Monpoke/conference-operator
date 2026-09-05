<script setup lang="ts">
import { DB_FLOOR } from '@conference-operator/contract'
import { Panel } from '@conference-operator/components'
import { useAudioStore } from '../stores/audio.js'

/**
 * OBS-B's VU meter.
 *
 * The thresholds are the edit suite's, not a scale invented here: green up to
 * −20 dB, amber after that, red past −9 dB. The note under the panel repeats
 * them, because a colour on its own does not say where it turns over.
 */
function tint(db: number): string {
  if (db > -9) return 'bg-alert'
  if (db > -20) return 'bg-warn'
  return 'bg-ok'
}

/** The bar's share, from the floor to zero. */
function width(db: number): string {
  const part = Math.max(0, Math.min(1, (db - DB_FLOOR) / -DB_FLOOR))
  return `${(part * 100).toFixed(1)}%`
}

const audio = useAudioStore()
</script>

<template>
  <Panel class="min-h-0 flex-1">
    <h2 class="mb-2.5 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
      Niveaux audio — OBS&nbsp;B
    </h2>

    <div class="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto" data-role="levels">
      <!--
        "En attente" and "aucune entrée" do not mean the same thing: the first is
        an OBS we have not heard yet, the second an OBS that answers and has
        nothing to let us listen to.
      -->
      <div v-if="audio.waiting" class="text-xs text-dim">En attente d'OBS…</div>
      <div v-else-if="audio.inputs.length === 0" class="text-xs text-dim">
        Aucune entrée audio — OBS-B est-il connecté ?
      </div>

      <div v-for="entry in audio.inputs" :key="entry.name" class="shrink-0">
        <div class="mb-1 flex items-baseline justify-between gap-2">
          <span class="truncate text-xs">{{ entry.name }}</span>
          <span
            class="shrink-0 text-[11px] tabular-nums"
            :class="(audio.peaks[entry.name]?.db ?? DB_FLOOR) > -9 ? 'text-alert' : 'text-dim'"
          >
            {{
              (audio.peaks[entry.name]?.db ?? DB_FLOOR) <= DB_FLOOR
                ? '—'
                : `${Math.round(audio.peaks[entry.name]!.db)} dB`
            }}
          </span>
        </div>
        <!-- One gauge per channel: mono and stereo coexist in the same room. -->
        <div class="flex flex-col gap-0.5">
          <div
            v-for="(channel, index) in entry.channels"
            :key="index"
            class="relative h-1.5 overflow-hidden rounded-full bg-canvas"
          >
            <div
              class="h-full rounded-full transition-[width] duration-75"
              :class="tint(channel.magnitude)"
              :style="{ width: width(channel.magnitude) }"
            ></div>
          </div>
        </div>
      </div>
    </div>

    <p class="mt-1.5 text-[11px] text-dim">
      Vert jusqu'à &minus;20 dB, jaune ensuite, rouge au-delà de &minus;9 dB.
    </p>
  </Panel>
</template>
