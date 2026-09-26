<script setup lang="ts">
import { Button, useToast } from '@conference-operator/components'
import type { MontageAnalyse, MontageJobView } from '@conference-operator/contract'
import { computed, ref, watch } from 'vue'
import { parseTimecode, timecode, useMontageStore } from '../stores/montage.js'

/**
 * Checking a cut before it is edited.
 *
 * What the analysis proposed, and why; the whole take as a waveform with the
 * two ends on it, to drag; the speaker arriving and leaving, in stills; the
 * first and last seconds, to hear whether a word is missing. Validating sends
 * the job to the montage on the cut shown here.
 */
const props = defineProps<{ job: MontageJobView }>()
const emit = defineEmits<{ validated: [job: MontageJobView] }>()

const store = useMontageStore()
const toast = useToast()

const analyse = ref<MontageAnalyse | null>(null)
const files = ref<Record<string, string>>({})
const error = ref('')
const debutMs = ref(0)
const finMs = ref(0)
const debutText = ref('')
const finText = ref('')
const saving = ref(false)

watch(
  () => props.job.id,
  async (jobId) => {
    analyse.value = null
    error.value = ''
    try {
      const view = await store.analysis(jobId)
      if (props.job.id !== jobId) return
      analyse.value = view.analyse
      files.value = Object.fromEntries(view.fichiers.map((file) => [file.nom, file.url]))
      if (view.analyse != null) reset(view.analyse)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Lecture impossible.'
    }
  },
  { immediate: true },
)

/** Back to the analysis' proposal — or to the cut already validated, when there is one. */
function reset(value: MontageAnalyse): void {
  const cut = props.job.coupe ?? value.proposition
  set('debut', cut.debutMs)
  set('fin', cut.finMs)
}

function set(which: 'debut' | 'fin', ms: number): void {
  const takeMs = analyse.value?.takeMs ?? Number.POSITIVE_INFINITY
  const clamped = Math.round(Math.min(takeMs, Math.max(0, ms)))
  if (which === 'debut') {
    debutMs.value = Math.min(clamped, finMs.value > 0 ? finMs.value - 1_000 : clamped)
    debutText.value = timecode(debutMs.value)
  } else {
    finMs.value = Math.max(clamped, debutMs.value + 1_000)
    finText.value = timecode(finMs.value)
  }
}

function typed(which: 'debut' | 'fin'): void {
  const ms = parseTimecode(which === 'debut' ? debutText.value : finText.value)
  if (ms == null) {
    toast.fail('Temps illisible : écrire mm:ss,d ou h:mm:ss,d.')
    set(which, which === 'debut' ? debutMs.value : finMs.value)
    return
  }
  set(which, ms)
}

/* ---------- The waveform and its two handles ---------- */
const wave = ref<HTMLElement | null>(null)
const dragging = ref<'debut' | 'fin' | null>(null)
const percent = (ms: number) => (analyse.value == null ? 0 : (ms / analyse.value.takeMs) * 100)

function msAt(event: PointerEvent): number {
  const box = wave.value!.getBoundingClientRect()
  return ((event.clientX - box.left) / box.width) * (analyse.value?.takeMs ?? 0)
}

function grab(event: PointerEvent): void {
  if (analyse.value == null || wave.value == null) return
  const ms = msAt(event)
  // The closer handle is the one taken: a click anywhere moves it there.
  dragging.value = Math.abs(ms - debutMs.value) <= Math.abs(ms - finMs.value) ? 'debut' : 'fin'
  wave.value.setPointerCapture(event.pointerId)
  set(dragging.value, ms)
}

function drag(event: PointerEvent): void {
  if (dragging.value != null) set(dragging.value, msAt(event))
}

function release(): void {
  dragging.value = null
}

/** The excerpts were cut around the proposal: past a few seconds, they no longer show the cut chosen. */
const moved = computed(() => {
  const proposal = analyse.value?.proposition
  if (proposal == null) return { debut: false, fin: false }
  return { debut: Math.abs(debutMs.value - proposal.debutMs) > 5_000, fin: Math.abs(finMs.value - proposal.finMs) > 5_000 }
})

const STILLS = { debut: ['−2 s', 'coupe', '+2 s', '+5 s'], fin: ['−5 s', '−2 s', 'coupe', '+2 s'] } as const
const CONFIDENCE_TONE: Record<string, string> = { haute: 'text-ok', moyenne: 'text-warn', basse: 'text-alert' }

async function validate(): Promise<void> {
  saving.value = true
  try {
    const job = await store.validate(props.job.id, debutMs.value, finMs.value)
    toast.say('Coupe validée : le montage part')
    emit('validated', job)
  } catch {
    /* already reported by the client's error hook */
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="mt-2 rounded-lg border border-edge p-3" data-role="coupe-validation">
    <p v-if="error !== ''" class="text-sm text-alert">{{ error }}</p>
    <p v-else-if="analyse == null" class="text-sm text-dim">Lecture de l’analyse…</p>

    <template v-else>
      <p class="text-sm">
        Confiance
        <strong :class="CONFIDENCE_TONE[analyse.confiance]">{{ analyse.confiance }}</strong>
        <span v-if="analyse.audio != null" class="text-dim">
          · son {{ analyse.audio.lufsAvant.toFixed(1) }} LUFS{{ analyse.audio.quasiMuet ? ' (quasi absent)' : ` → ${analyse.audio.lufsApres}` }}
        </span>
      </p>
      <ul class="mt-1 mb-2.5 list-disc pl-5 text-xs text-dim">
        <li v-for="raison in analyse.raisons" :key="raison">{{ raison }}</li>
      </ul>

      <!-- The whole take: the kept part lit, the rest dimmed. -->
      <div
        ref="wave"
        class="relative h-[100px] cursor-ew-resize touch-none overflow-hidden rounded-md bg-canvas select-none"
        @pointerdown="grab"
        @pointermove="drag"
        @pointerup="release"
        @pointercancel="release"
      >
        <img v-if="files['forme.png']" :src="files['forme.png']" alt="" class="pointer-events-none h-full w-full object-fill" />
        <div class="pointer-events-none absolute inset-y-0 left-0 bg-black/55" :style="{ width: `${percent(debutMs)}%` }" />
        <div class="pointer-events-none absolute inset-y-0 right-0 bg-black/55" :style="{ width: `${100 - percent(finMs)}%` }" />
        <div class="pointer-events-none absolute inset-y-0 w-0.5 bg-ok" :style="{ left: `${percent(debutMs)}%` }" />
        <div class="pointer-events-none absolute inset-y-0 w-0.5 bg-alert" :style="{ left: `${percent(finMs)}%` }" />
      </div>
      <p class="mt-1 text-[11px] text-dim">
        Prise de {{ timecode(analyse.takeMs) }} — glisser un repère, ou cliquer pour y amener le plus proche.
      </p>

      <div class="mt-2 grid grid-cols-2 gap-2">
        <label class="text-xs text-dim">
          Début
          <input v-model="debutText" class="mt-1 w-full rounded-lg border border-edge bg-canvas px-2 py-1.5 font-mono text-sm text-text"
            @change="typed('debut')" />
        </label>
        <label class="text-xs text-dim">
          Fin
          <input v-model="finText" class="mt-1 w-full rounded-lg border border-edge bg-canvas px-2 py-1.5 font-mono text-sm text-text"
            @change="typed('fin')" />
        </label>
      </div>

      <div v-for="side in (['debut', 'fin'] as const)" :key="side" class="mt-3">
        <h4 class="mb-1 text-[11px] font-semibold tracking-[.12em] text-dim uppercase">
          {{ side === 'debut' ? 'Arrivée' : 'Départ' }}
        </h4>
        <div class="grid grid-cols-4 gap-1">
          <figure v-for="(label, index) in STILLS[side]" :key="label" class="m-0">
            <img v-if="files[`${side}-${index + 1}.jpg`]" :src="files[`${side}-${index + 1}.jpg`]" alt="" class="w-full rounded" />
            <figcaption class="text-center text-[10px] text-dim">{{ label }}</figcaption>
          </figure>
        </div>
        <audio v-if="files[`${side}.mp3`]" :src="files[`${side}.mp3`]" controls preload="none" class="mt-1 w-full" />
        <p class="text-[11px]" :class="moved[side] ? 'text-warn' : 'text-dim'">
          <template v-if="moved[side]">Extrait pris autour de la coupe proposée, plus de celle-ci.</template>
          <template v-else>La coupe proposée tombe à {{ side === 'debut' ? '5' : '10' }} s de l’extrait.</template>
        </p>
      </div>

      <div class="mt-3 flex flex-wrap gap-1.5">
        <Button size="small" variant="primary" :disabled="saving" @click="validate">Valider et monter</Button>
        <Button size="small" @click="reset(analyse)">Revenir à la proposition</Button>
      </div>
    </template>
  </div>
</template>
