<script setup lang="ts">
import { DB_FLOOR } from '@cloudnord/contract'
import { Panel } from '@cloudnord/components'
import { useAudioStore } from '../stores/audio.js'

/**
 * Vumètre d'OBS-B.
 *
 * Les seuils sont ceux de la salle de editing, pas une échelle inventée ici :
 * vert jusqu'à −20 dB, jaune ensuite, rouge au-delà de −9 dB. La mention sous
 * le panneau les redit, parce qu'une couleur seule ne dit pas où elle bascule.
 */
function tint(db: number): string {
  if (db > -9) return 'bg-alert'
  if (db > -20) return 'bg-warn'
  return 'bg-ok'
}

/** Part de la barre, du plancher à zéro. */
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
        « En attente » et « aucune entrée » ne disent pas la même chose : le
        premier est un OBS qu'on n'a pas encore entendu, le second un OBS qui
        répond et n'a rien à faire écouter.
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
        <!-- Une jauge par canal : mono et stéréo coexistent dans la même salle. -->
        <div class="flex flex-col gap-0.5">
          <div
            v-for="(canal, index) in entry.channels"
            :key="index"
            class="relative h-1.5 overflow-hidden rounded-full bg-canvas"
          >
            <div
              class="h-full rounded-full transition-[width] duration-75"
              :class="tint(canal.magnitude)"
              :style="{ width: width(canal.magnitude) }"
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
