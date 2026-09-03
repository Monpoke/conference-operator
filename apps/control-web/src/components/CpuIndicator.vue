<script setup lang="ts">
import type { HostLoad } from '@cloudnord/contract'
import { computed } from 'vue'
import Gauge from './Gauge.vue'
import Indicator from './Indicator.vue'
import { worst, type Level } from './levels.js'

/**
 * Charge du poste, en pastille.
 *
 * La machine qui encode est le point faible invisible de la salle : quand elle
 * sature, OBS perd des images sans rien dire et le rush est mauvais sans que
 * personne s'en aperçoive avant le editing. Une couleur suffit à le voir de
 * loin ; le détail tient dans l'info-bulle, parce qu'un chiffre de plus dans le
 * bandeau se lirait tout le temps pour ne servir que trois fois dans la journée.
 *
 * « Poste » et non « CPU » : la pastille prend la pire des deux mesures, et une
 * pastille rouge sous un mot qui ne parle que du processeur enverrait chercher
 * la panne au mauvais endroit.
 */

/** Au-delà, l'encodage n'a plus de marge ; plus haut encore, il perd des images. */
const CPU_ATTENTION = 0.7
const CPU_ALERTE = 0.9

/**
 * L'autre façon dont un poste lâche, et la plus sournoise.
 *
 * La machine ne ralentit pas franchement : elle commence à échanger sur le
 * disque — celui-là même qui écrit le rush. Le symptôme visible est un
 * enregistrement qui saute, sans que le processeur ait bougé.
 */
const MEM_ATTENTION = 0.85
const MEM_ALERTE = 0.95

/**
 * Les quatre états de la charge, chacun avec ce qu'il coûte.
 *
 * Le verdict est écrit ici plutôt que déduit à l'affichage : une couleur seule
 * ne dit pas quoi faire, et l'opérateur qui survole la pastille au milieu d'un
 * talk n'a pas trois secondes pour se demander ce qu'elle attend de lui.
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

/** Octets en gigaoctets, à une décimale, à la française. */
function inGigabytes(bytes: number): string {
  return (bytes / 1_000_000_000).toFixed(1).replace('.', ',')
}

const cpu = computed(() => {
  const value = props.load?.cpu
  const known = typeof value === 'number'
  const level: Level = !known
    ? 'unknown'
    : value >= CPU_ALERTE
      ? 'alert'
      : value >= CPU_ATTENTION
        ? 'warn'
        : 'ok'
  return { known, level, percent: known ? Math.round(value * 100) : 0 }
})

const memory = computed(() => {
  const memory = props.load?.memory ?? null
  const part =
    memory != null && memory.totalBytes > 0 ? memory.usedBytes / memory.totalBytes : null
  const level: Level =
    part == null ? 'unknown' : part >= MEM_ALERTE ? 'alert' : part >= MEM_ATTENTION ? 'warn' : 'ok'
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
 * Le verdict revient à la mesure la plus grave : une mémoire pleine sous un
 * processeur au repos ne doit pas s'entendre dire « le poste encaisse ».
 */
const byMemory = computed(
  () =>
    memory.value.level !== cpu.value.level &&
    worst(cpu.value.level, memory.value.level) === memory.value.level,
)

/*
 * Le repli sur le verdict processeur n'est pas décoratif.
 *
 * Un processeur non mesuré ne l'emporte sur rien : la mémoire devient alors la
 * mesure « la plus grave » même quand elle va bien, et la table des verdicts
 * mémoire n'a rien à dire d'une mémoire qui va bien — elle ne parle que des
 * deux niveaux qui coûtent quelque chose. La page d'origine affichait
 * « undefined » dans ce cas, pendant la première fenêtre de mesure.
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
        <span :class="`niveau-${memory.level}`" class="ml-auto text-xs font-semibold tabular-nums">
          {{ memory.part == null ? '—' : `${memory.percent} %` }}
        </span>
      </div>
      <Gauge :percent="memory.percent" :level="memory.level" />
      <div class="mt-1.5 text-[11px] text-dim">{{ memory.detail }}</div>
    </template>
  </Indicator>
</template>
