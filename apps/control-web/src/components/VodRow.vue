<script setup lang="ts">
import type { VodEntry } from '@cloudnord/contract'
import { Button } from '@cloudnord/components'
import { fileSize, remaining, shortDuration, time } from '@cloudnord/format'
import { computed } from 'vue'
import { UPLOAD_WORDS, VERDICT_BADGES, useVodStore } from '../stores/vod.js'
import VodPreview from './VodPreview.vue'

const props = defineProps<{ entry: VodEntry; timeZone: string }>()

const vod = useVodStore()

const check = computed(() => props.entry.check)
const sidecar = computed(() => props.entry.sidecar)
const upload = computed(() => vod.uploadOf(props.entry.file))

/**
 * What is left to wait on this file, spelled out — or nothing to say.
 *
 * It is the answer to the packing-up question, the one the percentage leaves
 * whole: 60 % on four gigabytes of footage is two minutes or forty. The
 * computation is in the store, which alone sees the successive readings go by and
 * can smooth them; here we only read it.
 */
const eta = computed(() => {
  const ms = vod.etaOf(props.entry.file)
  return ms == null ? null : remaining(ms)
})

const badge = computed(
  () => VERDICT_BADGES[check.value?.status ?? ''] ?? ['Non vérifié', 'border-edge text-dim'],
)

const durationMs = computed(
  () => check.value?.probe?.durationMs ?? sidecar.value?.durationMs ?? null,
)

const speakers = computed(() =>
  (sidecar.value?.speakers ?? [])
    .map((person) => person.name)
    .filter(Boolean)
    .join(', '),
)

/** What is read at a glance: when, how much, and what is already missing. */
const details = computed(() => {
  const parts: string[] = []
  if (sidecar.value == null) parts.push('sidecar absent')
  else {
    parts.push(time(sidecar.value.startedAt, props.timeZone))
    const marks = sidecar.value.markers ?? []
    const chapters = marks.filter((marker) => marker.role == null).length
    if (chapters > 0) parts.push(`${chapters} marqueur${chapters > 1 ? 's' : ''}`)

    /*
     * What editing will trim, when the control app has told it so.
     *
     * This is the only window in which the information is still verifiable: the
     * file opens here, and the preview is one click away. Three weeks later, an
     * anchor set one minute too early is discovered on the published video.
     *
     * Nothing shown when no anchor was set: the take is over, no more can be set,
     * and a reproach with no remedy teaches nothing about what one came here to
     * check.
     */
    const start = marks.find((marker) => marker.role === 'debut')
    const end = marks.find((marker) => marker.role === 'fin')
    if (start != null || end != null) {
      const bound = (marker: typeof start): string =>
        marker == null ? '?' : shortDuration(marker.offsetMs)
      parts.push(`rognage ${bound(start)} → ${bound(end)}`)
    }
  }
  if (durationMs.value != null) parts.push(shortDuration(durationMs.value))
  parts.push(fileSize(props.entry.sizeBytes))
  if (props.entry.beingWritten) parts.push('encore en écriture')
  if (check.value?.by === 'operateur') parts.push('verdict de la régie')

  /*
   * The upload state is read on the same line as the rest: it is the same question
   * — "is this footage safe?" — and splitting it into two columns would force the
   * eye to cross-reference two lists.
   */
  const state = upload.value?.state
  if (state != null) {
    const word = UPLOAD_WORDS[state] ?? state
    if (state !== 'en-cours') parts.push(word)
    else {
      const left = eta.value == null ? '' : ` · reste ${eta.value}`
      parts.push(`${word} — ${upload.value?.percent} %${left}`)
    }
  }
  return parts.join(' · ')
})

/**
 * What the progress indicator says on hover.
 *
 * The percentage is already in the detail line, but that line is read looking for
 * a file, not for a figure. On the indicator it sits where the eye lands when one
 * wonders "and that one, how far along is it?".
 *
 * "environ" is no stylistic hedge: the announced time is worth whatever the last
 * three minutes of network were worth, and the operator deciding whether to unplug
 * a disk must read an estimate as an estimate.
 */
const progressTitle = computed(() => {
  if (upload.value?.state === 'attente') {
    return 'En file : le téléversement partira dès que la salle le permet'
  }
  const left = eta.value == null ? '' : `, reste environ ${eta.value}`
  return `Téléversement en cours — ${upload.value?.percent ?? 0} %${left}`
})

/**
 * A square cell, the same for all four icons.
 *
 * Without it, each button was as wide as its glyph: 👁 and ⬆ are emoji, ✓ and ✕
 * are text characters that are far narrower, and `px-3` on each side changed
 * nothing. Four buttons of four widths, shifting from one row to the next as soon
 * as the rest moved. The width is therefore fixed here, once, and `px-0` removes
 * the padding that made it depend on the content.
 */
const ICON_CELL = 'w-9 px-0'

/**
 * The upload column, at a reserved width.
 *
 * It was what shifted everything else: it carries sometimes a ⬆, sometimes a ☁,
 * sometimes an indicator **and** a "Annuler" button — three very different widths,
 * and therefore a ✓ and a ✕ that landed in the same place on no row at all. The
 * widest case's space is reserved on every row, and the content is pushed right:
 * ⬆, ☁ and "Annuler" thus share their right edge, the one that touches the ✓.
 */
const UPLOAD_COLUMN = 'flex w-[6.75rem] shrink-0 items-center justify-end gap-1'

/** "Active" on a verdict already set: the same button removes it. */
function posed(status: string): boolean {
  return check.value?.by === 'operateur' && check.value.status === status
}
</script>

<template>
  <div
    class="grid grid-cols-[1fr_auto] items-start gap-3 rounded-lg border border-edge p-2.5"
    :data-vod="entry.file"
  >
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2">
        <!--
          Fixed width, like the icons opposite and for the same reason: "Non
          vérifié", "Exploitable", "À revoir" and "Illisible" are not the same
          length, and the file name therefore began at four different offsets
          depending on the verdict. On a list scanned diagonally, it is that shift
          that is seen before the badge itself.
        -->
        <span
          class="w-24 shrink-0 rounded border px-1.5 py-px text-center text-[10px] font-semibold tracking-[.08em] uppercase"
          :class="badge[1]"
          data-role="vod-badge"
        >
          {{ badge[0] }}
        </span>
        <span class="truncate font-mono text-[12px] text-dim">{{ entry.file }}</span>
      </div>
      <div class="mt-1 truncate text-sm">
        {{ sidecar?.title ?? 'Titre inconnu' }}
        <span v-if="speakers !== ''" class="text-dim"> — {{ speakers }}</span>
      </div>
      <div class="mt-0.5 text-[11px] text-dim">{{ details }}</div>

      <!-- A red badge with no reason serves nobody. -->
      <div
        v-if="(check?.reasons.length ?? 0) > 0"
        class="mt-1 text-[11px]"
        :class="check?.status === 'ok' ? 'text-dim' : 'text-warn'"
      >
        {{ check?.reasons.join(' · ') }}
      </div>

      <!-- "AccessDenied" is the only word one can carry to whoever holds the
           bucket: translating it would lose the only handle on the problem. -->
      <div v-if="upload?.error != null" class="mt-1 text-[11px] text-alert">
        Téléversement : {{ upload.error }}
      </div>
    </div>

    <div class="flex shrink-0 items-center gap-1">
      <Button
        size="small"
        :class="ICON_CELL"
        title="Voir et entendre un extrait"
        :active="vod.preview?.file === entry.file"
        :data-vod-preview="entry.file"
        @click="vod.togglePreview(entry.file)"
      >
        👁
      </Button>
      <Button
        size="small"
        title="Relit le conteneur : pistes, durée réelle, débit"
        :data-vod-inspect="entry.file"
        @click="vod.inspect(entry.file)"
      >
        Vérifier
      </Button>

      <!--
        The same place across a file's whole life: ⬆, then a progress indicator,
        then ☁. The ⬆ used to disappear in favour of "Annuler", and the row lost at
        a stroke the only landmark that said where that particular file stood: on a
        modal lining up fifteen of them, one had to read the small detail line again
        to find the one that was uploading. The indicator keeps the place and
        carries the progress.

        It is **not** clickable, and that is deliberate: "Annuler" stays a named
        button, beside it. An indicator that cancelled on click would lose three
        gigabytes already uploaded to a distracted finger — exactly what the ☁ with
        no button avoids at the other end.

        The whole thing is absent while the hub has no destination: a button that
        fails on every click is worse than an absent button, and the header already
        says why.
      -->
      <div v-if="vod.blocked == null" :class="UPLOAD_COLUMN">
        <template v-if="upload?.state === 'en-cours' || upload?.state === 'attente'">
          <span
            class="flex h-6 w-6 shrink-0 items-center justify-center"
            :title="progressTitle"
            :data-vod-progress="entry.file"
          >
            <!--
              Deux allures pour deux états, parce qu'ils ne disent pas la même
              chose : ça tourne quand des octets partent, ça bat quand on attend
              une fenêtre. Un anneau qui tourne sur une file d'attente ferait
              croire à une montée qui n'avance pas.
            -->
            <span
              class="h-3.5 w-3.5 rounded-full border-2 border-edge"
              :class="
                upload?.state === 'en-cours'
                  ? 'animate-spin border-t-brand'
                  : 'animate-pulse border-t-warn'
              "
            ></span>
          </span>
          <Button
            size="small"
            title="Renoncer à ce téléversement"
            :data-vod-cancel="entry.file"
            @click="vod.cancelUpload(entry.file)"
          >
            Annuler
          </Button>
        </template>
        <span
          v-else-if="upload?.state === 'termine'"
          class="flex w-9 shrink-0 justify-center text-[13px] text-dim"
          title="Rush et sidecar déjà envoyés : rien à faire de plus"
        >
          ☁
        </span>
        <Button
          v-else
          size="small"
          :class="ICON_CELL"
          :title="
            entry.beingWritten
              ? 'Prise encore en cours : le fichier partira une fois arrêtée'
              : 'Envoyer ce rush et son sidecar au stockage'
          "
          :data-vod-upload="entry.file"
          @click="vod.upload(entry.file)"
        >
          ⬆
        </Button>
      </div>

      <Button
        size="small"
        :class="ICON_CELL"
        title="Fichier ouvert et relu : exploitable"
        :active="posed('ok')"
        :data-vod-verdict-ok="entry.file"
        @click="vod.verdict(entry.file, 'ok')"
      >
        ✓
      </Button>
      <Button
        size="small"
        :class="ICON_CELL"
        title="Fichier inexploitable : à refaire ou à signaler"
        :active="posed('illisible')"
        :data-vod-verdict-ko="entry.file"
        @click="vod.verdict(entry.file, 'illisible')"
      >
        ✕
      </Button>
    </div>

    <VodPreview v-if="vod.preview?.file === entry.file" :entry="entry" />
  </div>
</template>
