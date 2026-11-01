<script setup lang="ts">
import { Button } from '@conference-operator/components'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { timecode } from '../stores/montage.js'
import { centredOn, clampView, levelScale, levelsFor, tickStep, zoomAround, type Niveaux, type TimelineView } from '../stores/timeline.js'

/**
 * The take, to place a cut on: the whole of it in a strip, the part in view below.
 *
 * Clicking moves the playhead and never a cut: when listening is how a cut is
 * checked, a click that also moved it would lose what was being checked.
 */
const props = defineProps<{
  takeMs: number
  niveaux: Niveaux | null
  /** The waveform image of a take analysed before its levels were kept. */
  imageUrl: string | null
  debutMs: number
  finMs: number
  positionMs: number
}>()
const emit = defineEmits<{ debut: [ms: number]; fin: [ms: number]; seek: [ms: number] }>()

/** Enough to read a sentence's first word: what the buttons around a cut show. */
const AROUND_MS = 30_000

const view = ref<TimelineView>({ fromMs: 0, toMs: props.takeMs })
const main = ref<HTMLElement | null>(null)
const overview = ref<HTMLElement | null>(null)
const mainCanvas = ref<HTMLCanvasElement | null>(null)
const overviewCanvas = ref<HTMLCanvasElement | null>(null)
const widthPx = ref(1000)

const whole = computed<TimelineView>(() => ({ fromMs: 0, toMs: props.takeMs }))
const scale = computed(() => levelScale(props.niveaux?.db ?? []))
const span = computed(() => view.value.toMs - view.value.fromMs)
const zoom = computed(() => Math.round(props.takeMs / Math.max(1, span.value)))
const place = (ms: number) => ((ms - view.value.fromMs) / Math.max(1, span.value)) * 100
const inView = (ms: number) => ms >= view.value.fromMs && ms <= view.value.toMs

const ticks = computed(() => {
  const step = tickStep(span.value, widthPx.value)
  const out: number[] = []
  for (let ms = Math.ceil(view.value.fromMs / step) * step; ms <= view.value.toMs; ms += step) out.push(ms)
  return out
})

/** The image can only be stretched: it stands in until the take is analysed again. */
const imageStyle = computed(() => ({
  width: `${(props.takeMs / Math.max(1, span.value)) * 100}%`,
  left: `${(-view.value.fromMs / Math.max(1, span.value)) * 100}%`,
}))

function draw(canvas: HTMLCanvasElement | null, range: TimelineView): void {
  if (canvas == null || props.niveaux == null) return
  const context = canvas.getContext?.('2d')
  if (context == null) return
  const ratio = window.devicePixelRatio || 1
  const width = Math.round(canvas.clientWidth * ratio)
  const height = Math.round(canvas.clientHeight * ratio)
  if (width === 0 || height === 0) return
  canvas.width = width
  canvas.height = height
  context.fillStyle = getComputedStyle(canvas).color
  const levels = levelsFor(props.niveaux, range, width, scale.value)
  for (let x = 0; x < width; x += 1) {
    const bar = Math.max(1, levels[x]! * height)
    context.fillRect(x, (height - bar) / 2, 1, bar)
  }
}

function redraw(): void {
  draw(mainCanvas.value, view.value)
  draw(overviewCanvas.value, whole.value)
}
watch([view, () => props.niveaux], redraw, { flush: 'post' })
watch(() => props.takeMs, () => {
  view.value = { ...whole.value }
})

let observer: ResizeObserver | null = null
onMounted(() => {
  redraw()
  if (typeof ResizeObserver === 'undefined' || main.value == null) return
  observer = new ResizeObserver(() => {
    widthPx.value = main.value?.clientWidth ?? widthPx.value
    redraw()
  })
  observer.observe(main.value)
})
onBeforeUnmount(() => observer?.disconnect())

/** The playhead stays in sight while the take plays, or after a jump. */
watch(() => props.positionMs, (ms) => {
  if (dragging == null && !inView(ms)) view.value = clampView({ fromMs: ms - span.value * 0.1, toMs: ms + span.value * 0.9 }, props.takeMs)
})

function msAt(event: { clientX: number }, element: HTMLElement, range: TimelineView): number {
  const box = element.getBoundingClientRect()
  const ratio = box.width === 0 ? 0 : (event.clientX - box.left) / box.width
  return range.fromMs + Math.min(1, Math.max(0, ratio)) * (range.toMs - range.fromMs)
}

let dragging: 'debut' | 'fin' | 'pan' | null = null
let panFrom = { x: 0, view: view.value }
let moved = false

function press(event: PointerEvent): void {
  if (main.value == null) return
  const handle = (event.target as Element).closest?.('[data-handle]')?.getAttribute('data-handle') as 'debut' | 'fin' | null | undefined
  dragging = handle ?? 'pan'
  moved = false
  panFrom = { x: event.clientX, view: view.value }
  main.value.setPointerCapture?.(event.pointerId)
}

function move(event: PointerEvent): void {
  if (dragging == null || main.value == null) return
  if (Math.abs(event.clientX - panFrom.x) > 3) moved = true
  if (dragging === 'pan') {
    const perPx = (panFrom.view.toMs - panFrom.view.fromMs) / Math.max(1, main.value.clientWidth)
    const shift = (panFrom.x - event.clientX) * perPx
    view.value = clampView({ fromMs: panFrom.view.fromMs + shift, toMs: panFrom.view.toMs + shift }, props.takeMs)
  } else if (dragging === 'debut') {
    emit('debut', msAt(event, main.value, view.value))
  } else {
    emit('fin', msAt(event, main.value, view.value))
  }
}

function release(event: PointerEvent): void {
  if (dragging === 'pan' && !moved && main.value != null) emit('seek', msAt(event, main.value, view.value))
  dragging = null
}

function wheel(event: WheelEvent): void {
  if (main.value == null) return
  if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    const shift = ((event.deltaX || event.deltaY) / Math.max(1, main.value.clientWidth)) * span.value
    view.value = clampView({ fromMs: view.value.fromMs + shift, toMs: view.value.toMs + shift }, props.takeMs)
    return
  }
  view.value = zoomAround(view.value, msAt(event, main.value, view.value), Math.exp(event.deltaY * 0.002), props.takeMs)
}

function zoomBy(factor: number): void {
  const at = inView(props.positionMs) ? props.positionMs : (view.value.fromMs + view.value.toMs) / 2
  view.value = zoomAround(view.value, at, factor, props.takeMs)
}

function focus(ms: number): void {
  view.value = centredOn(ms, AROUND_MS, props.takeMs)
}

function moveWindow(event: PointerEvent): void {
  if (overview.value == null || (event.type === 'pointermove' && event.buttons === 0)) return
  if (event.type === 'pointerdown') overview.value.setPointerCapture?.(event.pointerId)
  view.value = centredOn(msAt(event, overview.value, whole.value), span.value, props.takeMs)
}

function nudge(event: KeyboardEvent, which: 'debut' | 'fin'): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  event.stopPropagation()
  const step = (event.shiftKey ? 1_000 : 100) * (event.key === 'ArrowLeft' ? -1 : 1)
  if (which === 'debut') emit('debut', props.debutMs + step)
  else emit('fin', props.finMs + step)
}

defineExpose({ focus, zoomBy })
</script>

<template>
  <div data-role="timeline">
    <div class="mb-1.5 flex flex-wrap items-center gap-1.5">
      <Button size="small" data-zoom="in" aria-label="Zoomer" @click="zoomBy(0.5)">+</Button>
      <Button size="small" data-zoom="out" aria-label="Dézoomer" @click="zoomBy(2)">−</Button>
      <Button size="small" data-zoom="all" @click="view = { ...whole }">Toute la prise</Button>
      <Button size="small" data-focus="debut" @click="focus(debutMs)">Autour du début</Button>
      <Button size="small" data-focus="fin" @click="focus(finMs)">Autour de la fin</Button>
      <span class="min-w-0 flex-1 truncate pl-2 text-[11px] text-dim max-md:hidden" title="Molette : zoom · Glisser : se déplacer · Clic : placer la lecture · Espace : lecture · ← → : 1 s (Maj : 0,1 s) · I / O : début / fin ici">
        Molette : zoom · Glisser : se déplacer · Clic : lecture · Espace · ← → · I / O : début / fin ici
      </span>
      <span class="ml-auto text-[11px] tabular-nums text-dim" data-role="timeline-view">
        ×{{ zoom }} · {{ timecode(view.fromMs) }} → {{ timecode(view.toMs) }}
      </span>
    </div>

    <!-- The whole take, the part in view framed: where one is, and a way to go elsewhere. -->
    <div
      ref="overview"
      class="relative h-5 cursor-pointer touch-none overflow-hidden rounded bg-canvas select-none"
      data-role="timeline-overview"
      @pointerdown="moveWindow"
      @pointermove="moveWindow"
    >
      <canvas v-if="niveaux != null" ref="overviewCanvas" class="absolute inset-0 h-full w-full text-dim" />
      <img v-else-if="imageUrl != null" :src="imageUrl" alt="" class="pointer-events-none absolute inset-0 h-full w-full object-fill opacity-60" />
      <div class="pointer-events-none absolute inset-y-0 w-px bg-ok" :style="{ left: `${(debutMs / takeMs) * 100}%` }" />
      <div class="pointer-events-none absolute inset-y-0 w-px bg-alert" :style="{ left: `${(finMs / takeMs) * 100}%` }" />
      <div
        class="pointer-events-none absolute inset-y-0 min-w-1 border-x border-text bg-text/10"
        :style="{ left: `${(view.fromMs / takeMs) * 100}%`, width: `${(span / takeMs) * 100}%` }"
      />
    </div>

    <div class="relative mt-1 h-4 overflow-hidden text-[10px] tabular-nums text-dim select-none" aria-hidden="true">
      <span v-for="tick in ticks" :key="tick" class="absolute top-0 border-l border-edge pl-1" :style="{ left: `${place(tick)}%` }">{{ timecode(tick) }}</span>
    </div>

    <div
      ref="main"
      class="relative h-24 cursor-text touch-none overflow-hidden rounded bg-canvas select-none"
      data-role="timeline-main"
      @pointerdown="press"
      @pointermove="move"
      @pointerup="release"
      @pointercancel="release"
      @wheel.prevent="wheel"
    >
      <canvas v-if="niveaux != null" ref="mainCanvas" class="absolute inset-0 h-full w-full text-brand" />
      <img v-else-if="imageUrl != null" :src="imageUrl" alt="" class="pointer-events-none absolute inset-y-0 h-full max-w-none object-fill" :style="imageStyle" />
      <div class="pointer-events-none absolute inset-y-0 left-0 bg-canvas/75" :style="{ width: `${Math.min(100, Math.max(0, place(debutMs)))}%` }" />
      <div class="pointer-events-none absolute inset-y-0 right-0 bg-canvas/75" :style="{ width: `${Math.min(100, Math.max(0, 100 - place(finMs)))}%` }" />
      <div v-if="inView(positionMs)" class="pointer-events-none absolute inset-y-0 w-px bg-text" data-role="playhead" :style="{ left: `${place(positionMs)}%` }" />

      <template v-for="side in (['debut', 'fin'] as const)" :key="side">
        <div
          v-if="inView(side === 'debut' ? debutMs : finMs)"
          :data-handle="side"
          role="slider"
          tabindex="0"
          :aria-label="side === 'debut' ? 'Début de la coupe' : 'Fin de la coupe'"
          :aria-valuemin="0"
          :aria-valuemax="takeMs"
          :aria-valuenow="Math.round(side === 'debut' ? debutMs : finMs)"
          :aria-valuetext="timecode(side === 'debut' ? debutMs : finMs)"
          class="absolute inset-y-0 z-10 w-4 -translate-x-1/2 cursor-ew-resize outline-none"
          :style="{ left: `${place(side === 'debut' ? debutMs : finMs)}%` }"
          @keydown="nudge($event, side)"
        >
          <div class="mx-auto h-full w-0.5" :class="side === 'debut' ? 'bg-ok' : 'bg-alert'" />
          <span
            class="absolute top-0 rounded-sm px-1 text-[10px] font-semibold text-canvas"
            :class="side === 'debut' ? 'left-2 bg-ok' : 'right-2 bg-alert'"
          >{{ side === 'debut' ? 'Début' : 'Fin' }}</span>
        </div>
      </template>
    </div>

    <p v-if="niveaux == null" class="mt-1 text-[11px] text-warn" data-role="timeline-sans-niveaux">
      Audiogramme d’ancienne analyse : le zoom reste flou. « Relancer l’analyse » calcule les niveaux, sans rien monter.
    </p>
  </div>
</template>
