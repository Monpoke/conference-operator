<script setup lang="ts">
import { StatusDot } from '@cloudnord/components'
import { computed } from 'vue'
import Gauge from './Gauge.vue'
import type { Level } from './levels.js'

/**
 * Un indicateur d'en-tête : sa pastille, son info-bulle, et ce qu'un lecteur
 * d'écran en dira.
 *
 * Les deux indicateurs passent par ici, et c'est le point : ils se lisent d'un
 * même coup d'œil parce qu'ils sont bâtis d'une même main — la couleur au même
 * endroit, le verdict à la même place, le chiffre au même format. Deux rendus
 * séparés auraient divergé au premier ajout.
 *
 * L'info-bulle native disait la même chose, mais après une seconde d'attente,
 * dans la police du système, et sans pouvoir colorer le chiffre — qui est
 * justement toute l'information.
 *
 * `data-niveau` ne pilote aucune couleur, contrairement à ce que la page
 * d'origine affirmait : aucune règle ne l'a jamais lu. Il reste parce qu'il est
 * ce que les tests observent — le niveau retenu pour la pastille, exposé sans
 * passer par une classe utilitaire qui pourrait changer de nom.
 */
const props = defineProps<{
  title: string
  /** La mesure, déjà mise en forme. Une chaîne : « 42 % », « Connecté », « — ». */
  value: string
  /** Le verdict en deux mots, à droite du chiffre. */
  label: string
  /** Niveau du bloc — celui de la pastille, lisible de l'autre bout de la salle. */
  level: Level
  /**
   * Niveau de la mesure elle-même, quand il diffère de celui du bloc.
   *
   * Un processeur au repos reste vert sous une pastille rouge de mémoire : la
   * couleur du grand chiffre est celle de *sa* mesure, pas celle du bloc.
   */
  valueLevel?: Level
  /** Part mesurée, de 0 à 100. Omis quand la mesure n'est pas une part. */
  gauge?: number
  detail: string
  verdict: string
  /**
   * Ce que le lecteur d'écran annonce.
   *
   * L'info-bulle est décorative : elle ne fait que mettre en forme cette
   * phrase-là. Reconstruite depuis les champs quand elle n'est pas fournie.
   */
  summary?: string
}>()

const tint = computed(() => `niveau-${props.valueLevel ?? props.level}`)

const spoken = computed(
  () =>
    props.summary ??
    `${props.title} : ${props.value}, ${props.label} — ${props.detail}. ${props.verdict}`,
)
</script>

<template>
  <div
    class="indicateur relative flex shrink-0 items-center gap-1.5 text-xs text-dim"
    tabindex="0"
    :data-niveau="level"
    :aria-label="spoken"
  >
    <StatusDot :level="level" />
    <!--
      Le mot à côté de la pastille : « hors ligne », « Poste ».

      Le lecteur d'écran lit l'`aria-label` du bloc, qui est focusable : la
      bulle rediait mot pour mot la même chose, découpée en cinq bribes sans
      ordre. D'où `aria-hidden` sur elle, et rien ici.
    -->
    <span><slot /></span>
    <div class="bulle" aria-hidden="true">
      <div class="text-[10px] font-semibold tracking-[.12em] text-dim uppercase">
        {{ title }}
      </div>
      <div class="mt-1 mb-2 flex items-baseline gap-2">
        <span :class="tint" class="text-[22px] leading-none font-semibold tabular-nums">
          {{ value }}
        </span>
        <span :class="tint" class="ml-auto text-right text-[11px] font-semibold">{{ label }}</span>
      </div>
      <Gauge v-if="gauge != null" :percent="gauge" :level="valueLevel ?? level" />
      <div class="mt-1.5 text-[11px] text-dim">{{ detail }}</div>
      <slot name="extra" />
      <div class="mt-2 border-t border-edge pt-2 text-xs leading-snug text-text">
        {{ verdict }}
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * Écrite à la main plutôt qu'en utilitaires : elle tient à trois choses
 * qu'aucune classe n'exprime — l'apparition au survol *et* au clavier, la
 * flèche en ::before, et un fond qui doit prolonger le coin du bloc.
 */
.indicateur {
  cursor: help;
}
.indicateur .bulle {
  position: absolute;
  top: calc(100% + 9px);
  left: -10px;
  z-index: 30;
  width: 270px;
  padding: 11px 13px;
  border: 1px solid var(--color-edge);
  border-radius: 10px;
  background: var(--color-surface2);
  color: var(--color-text);
  box-shadow: 0 12px 30px rgb(0 0 0 / 0.5);
  opacity: 0;
  transform: translateY(-4px);
  pointer-events: none;
  transition:
    opacity 0.12s ease,
    transform 0.12s ease;
}
/* La flèche prolonge le coin : même fond, et les deux bords qu'elle croise. */
.indicateur .bulle::before {
  content: '';
  position: absolute;
  top: -5px;
  left: 15px;
  width: 8px;
  height: 8px;
  background: var(--color-surface2);
  transform: rotate(45deg);
  border-left: 1px solid var(--color-edge);
  border-top: 1px solid var(--color-edge);
}
.indicateur:hover .bulle,
.indicateur:focus-visible .bulle {
  opacity: 1;
  transform: translateY(0);
}
.indicateur:focus-visible {
  outline: none;
}

/*
 * Un seul vocabulaire de couleurs, du chiffre à la jauge.
 *
 * `:deep()` parce que l'encart de la mémoire arrive par un slot : il porte la
 * portée de l'appelant, pas celle d'ici, et sans cela son pourcentage
 * resterait de la couleur du texte courant.
 */
.indicateur :deep(.niveau-ok) {
  color: var(--color-ok);
}
.indicateur :deep(.niveau-warn) {
  color: var(--color-warn);
}
.indicateur :deep(.niveau-alert) {
  color: var(--color-alert);
}
.indicateur :deep(.niveau-inconnu) {
  color: var(--color-dim);
}
</style>
