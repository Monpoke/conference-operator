<script setup lang="ts">
import type { HostLoad } from '@conference-operator/contract'
import { computed } from 'vue'
import Gauge from './Gauge.vue'
import Indicator from './Indicator.vue'
import { worst, type Level } from './levels.js'

/**
 * The machine's load, as a dot.
 *
 * The encoding machine is the room's invisible weak point: when it saturates, OBS
 * drops frames without a word and the footage is bad with nobody noticing before
 * editing. A colour is enough to see it from afar; the detail lives in the
 * tooltip, because one more figure in the header would be read all the time only
 * to be of use three times a day.
 *
 * "Poste" and not "CPU": the dot takes the worse of the two measurements, and a
 * red dot under a word that speaks only of the processor would send people
 * looking for the fault in the wrong place.
 */

/** Past this, encoding has no margin left; higher still, it drops frames. */
const CPU_WARN = 0.7
const CPU_ALERT = 0.9

/**
 * The other way a machine gives out, and the most insidious.
 *
 * The machine does not slow down outright: it starts swapping to disk — the very
 * one writing the footage. The visible symptom is a recording that stutters, with
 * the processor never having moved.
 */
const MEM_WARN = 0.85
const MEM_ALERT = 0.95

/**
 * The four load states, each with what it costs.
 *
 * The verdict is written here rather than deduced at display time: a colour on its
 * own does not say what to do, and the operator hovering the dot in the middle of
 * a talk does not have three seconds to wonder what it expects of them.
 */
const CPU_LEVELS: Record<Level, { label: string; verdict: string }> = {
  ok: { label: 'marge confortable', verdict: 'Le poste encaisse l’encodage sans forcer.' },
  warn: {
    label: 'charge soutenue',
    verdict: 'Plus de marge pour un imprévu : fermez ce qui n’est pas la régie.',
  },
  alert: {
    label: 'saturé',
    verdict:
      'OBS perd probablement des images, et rien d’autre ne le dira. Le rush s’abîme maintenant.',
  },
  unknown: {
    label: 'mesure indisponible',
    verdict: 'Pastille sans valeur, pas poste au repos : la charge n’a pas pu être lue.',
  },
}

const MEM_VERDICTS: Partial<Record<Level, string>> = {
  warn:
    'La mémoire se remplit. Fermez les onglets et les lecteurs vidéo ouverts à côté avant le prochain talk.',
  alert:
    'Mémoire pleine : la machine va échanger sur le disque, celui-là même qui écrit le rush. Fermez tout le reste maintenant.',
}

const props = defineProps<{ load: HostLoad | null }>()

/** Bytes as gigabytes, to one decimal, in the French style. */
function inGigabytes(bytes: number): string {
  return (bytes / 1_000_000_000).toFixed(1).replace('.', ',')
}

const cpu = computed(() => {
  const value = props.load?.cpu
  const known = typeof value === 'number'
  const level: Level = !known
    ? 'unknown'
    : value >= CPU_ALERT
      ? 'alert'
      : value >= CPU_WARN
        ? 'warn'
        : 'ok'
  return { known, level, percent: known ? Math.round(value * 100) : 0 }
})

const memory = computed(() => {
  const memory = props.load?.memory ?? null
  const part =
    memory != null && memory.totalBytes > 0 ? memory.usedBytes / memory.totalBytes : null
  const level: Level =
    part == null ? 'unknown' : part >= MEM_ALERT ? 'alert' : part >= MEM_WARN ? 'warn' : 'ok'
  return {
    part,
    level,
    percent: part == null ? 0 : Math.round(part * 100),
    detail:
      memory == null || part == null
        ? 'mémoire illisible sur cette machine'
        : `${inGigabytes(memory.usedBytes)} Go occupés sur ${inGigabytes(memory.totalBytes)}`,
  }
})

const cpuDetail = computed(() => {
  if (cpu.value.known && props.load != null) {
    const window = Math.max(1, Math.round((props.load.windowMs || 0) / 1000))
    return `processeur · moyenne sur ${window} s · ${props.load.cores} cœurs`
  }
  return props.load == null
    ? 'le serveur local de la salle n’a pas répondu'
    : 'première mesure en cours, le temps d’une fenêtre'
})

/*
 * The verdict goes to the graver measurement: a full memory under a processor at
 * rest must not be told "le poste encaisse".
 */
const byMemory = computed(
  () =>
    memory.value.level !== cpu.value.level &&
    worst(cpu.value.level, memory.value.level) === memory.value.level,
)

/*
 * Falling back on the processor's verdict is not decorative.
 *
 * An unmeasured processor wins over nothing: memory then becomes the "graver"
 * measurement even when it is fine, and the memory verdict table has nothing to
 * say about a memory that is fine — it only speaks of the two levels that cost
 * something. The original page displayed "undefined" in that case, during the
 * first measurement window.
 */
const verdict = computed(() =>
  byMemory.value
    ? (MEM_VERDICTS[memory.value.level] ?? CPU_LEVELS[cpu.value.level].verdict)
    : CPU_LEVELS[cpu.value.level].verdict,
)

const value = computed(() => (cpu.value.known ? `${cpu.value.percent} %` : '—'))

const spoken = computed(
  () =>
    `Charge du poste : processeur ${cpu.value.known ? `${cpu.value.percent} %` : 'non mesuré'}, ` +
    `${CPU_LEVELS[cpu.value.level].label} — ${cpuDetail.value}. ` +
    `Mémoire ${memory.value.part == null ? 'non mesurée' : `${memory.value.percent} %, ${memory.value.detail}`}. ` +
    verdict.value,
)
</script>

<template>
  <Indicator
    title="Charge du poste"
    :value="value"
    :label="CPU_LEVELS[cpu.level].label"
    :detail="cpuDetail"
    :verdict="verdict"
    :summary="spoken"
    :gauge="cpu.percent"
    :value-level="cpu.level"
    :level="worst(cpu.level, memory.level)"
  >
    Poste
    <template #extra>
      <div class="mt-2.5 mb-1 flex items-baseline gap-2">
        <span class="text-[10px] font-semibold tracking-[.12em] text-dim uppercase">
          Mémoire
        </span>
        <span :class="`level-${memory.level}`" class="ml-auto text-xs font-semibold tabular-nums">
          {{ memory.part == null ? '—' : `${memory.percent} %` }}
        </span>
      </div>
      <Gauge :percent="memory.percent" :level="memory.level" />
      <div class="mt-1.5 text-[11px] text-dim">{{ memory.detail }}</div>
    </template>
  </Indicator>
</template>
