<script setup lang="ts">
import type { WallStatsCount, WallStatsTopPost } from '@conference-operator/contract'
import { Button, Empty, Hint, StableLabel } from '@conference-operator/components'
import { timeAgo } from '@conference-operator/format'
import { storeToRefs } from 'pinia'
import { computed, onMounted } from 'vue'
import { viewPath } from '@conference-operator/contract'
import { joursResumes, useModerationStore } from '../stores/moderation.js'

/**
 * The social wall in figures: what the hub holds and what the rooms and the
 * public page showed, then what walls.io's API says. Bars are plain divs: no
 * chart library to ship, nothing to load from outside.
 */
const store = useModerationStore()
const { stats, statsLoading } = storeToRefs(store)

const SOURCES: Record<string, string> = { form: 'Public (formulaire)', hub: 'Console', wallsio: 'walls.io' }

onMounted(() => void refresh())

async function refresh(): Promise<void> {
  try {
    await store.loadStats()
  } catch {
    /* already reported by the hub client */
  }
}

const n = (value: number) => value.toLocaleString('fr-FR')

const DAY = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
const dayLabel = (day: string) => DAY.format(new Date(`${day}T00:00:00Z`))

const networks = computed<WallStatsCount[]>(() =>
  (stats.value?.posts.byNetwork ?? []).map((entry) => ({ ...entry, label: SOURCES[entry.label] ?? entry.label })),
)
const days = computed<WallStatsCount[]>(() => {
  const { detail, autres } = joursResumes(stats.value?.posts.byDay ?? [])
  const rows = detail.map((entry) => ({ label: dayLabel(entry.day), count: entry.count }))
  return autres == null ? rows : [...rows, { label: `${autres.jours} autres jours`, count: autres.count }]
})
const motsUrl = computed(() => {
  const base = stats.value?.adressePublique
  return base == null ? null : `${base.replace(/\/+$/, '')}/mots`
})
const bouclePath = viewPath('boucle')
const media = computed<WallStatsCount[]>(() => {
  const split = stats.value?.posts.byMedia
  if (split == null) return []
  return [
    { label: 'Vidéo', count: split.video },
    { label: 'Photo', count: split.photo },
    { label: 'Texte', count: split.text },
  ]
})
const sentiment = computed<WallStatsCount[]>(() => {
  const split = stats.value?.wallsio?.sentiment
  if (split == null) return []
  return [
    { label: 'Positif', count: split.positive },
    { label: 'Neutre', count: split.neutral },
    { label: 'Négatif', count: split.negative },
    { label: 'Non évalué', count: split.unknown },
  ]
})

function width(entry: WallStatsCount, all: WallStatsCount[]): string {
  const top = Math.max(1, ...all.map((other) => other.count))
  return `${Math.round((entry.count / top) * 100)}%`
}

function topLine(post: WallStatsTopPost): string {
  return [post.author, post.network].filter(Boolean).join(' · ')
}
</script>

<template>
  <div id="wall-stats" class="mt-3.5">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <p class="m-0 text-xs text-dim">
        <template v-if="stats">Calculé {{ timeAgo(stats.generatedAt) }}</template>
      </p>
      <a v-if="motsUrl != null" id="wall-stats-mots" :href="motsUrl" target="_blank" rel="noopener" class="ml-auto text-sm text-brand underline">Voir le mur de mots</a>
      <p v-else-if="stats" id="wall-stats-mots-absent" class="m-0 ml-auto text-xs text-dim">
        Mur de mots : renseignez l'adresse de la page publique dans <a :href="bouclePath" class="text-brand underline">Boucle</a>.
      </p>
      <Button id="btn-wall-stats-refresh" size="small" :disabled="statsLoading" @click="refresh">
        <StableLabel :current="statsLoading ? 'Lecture…' : 'Actualiser'" :labels="['Lecture…', 'Actualiser']" />
      </Button>
    </div>

    <Empty v-if="stats == null">{{ statsLoading ? 'Lecture des statistiques…' : 'Statistiques indisponibles.' }}</Empty>

    <template v-else>
      <div class="mb-3.5 grid grid-cols-[repeat(auto-fit,minmax(min(170px,100%),1fr))] gap-2.5">
        <div class="rounded-[9px] border border-edge p-3" data-stat="posts">
          <div class="text-[11px] font-semibold tracking-[.1em] text-dim uppercase">Posts</div>
          <div class="text-2xl font-semibold">{{ n(stats.posts.total) }}</div>
        </div>
        <div class="rounded-[9px] border border-edge p-3" data-stat="impressions">
          <div class="text-[11px] font-semibold tracking-[.1em] text-dim uppercase">Affichages sur les écrans</div>
          <div class="text-2xl font-semibold">{{ n(stats.impressions.total) }}</div>
        </div>
        <div class="rounded-[9px] border border-edge p-3" data-stat="online-views">
          <div class="text-[11px] font-semibold tracking-[.1em] text-dim uppercase">Vues en ligne</div>
          <div class="text-2xl font-semibold">{{ n(stats.onlineViews.total) }}</div>
        </div>
        <div class="rounded-[9px] border border-edge p-3" data-stat="authors">
          <div class="text-[11px] font-semibold tracking-[.1em] text-dim uppercase">Auteurs distincts (walls.io)</div>
          <div class="text-2xl font-semibold">{{ stats.wallsio ? n(stats.wallsio.authors.total) : '—' }}</div>
        </div>
      </div>

      <div class="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-x-5 gap-y-4">
        <section
          v-for="block in [
            { id: 'networks', title: 'Par réseau', rows: networks },
            { id: 'days', title: 'Jours les plus actifs', rows: days },
            { id: 'media', title: 'Vidéo / photo / texte', rows: media },
          ]"
          :key="block.id"
          :data-block="block.id"
        >
          <h3 class="mb-2 text-sm font-semibold">{{ block.title }}</h3>
          <p v-if="block.rows.length === 0" class="text-xs text-dim">Aucun post publié.</p>
          <div v-for="row in block.rows" :key="row.label" class="mb-1.5 text-xs" :data-row="row.label">
            <div class="mb-0.5 flex justify-between gap-2">
              <span class="truncate">{{ row.label }}</span>
              <span class="text-dim tabular-nums">{{ n(row.count) }}</span>
            </div>
            <div class="h-2 rounded-full bg-surface2">
              <div class="h-2 rounded-full bg-brand" :style="{ width: width(row, block.rows) }" />
            </div>
          </div>
        </section>

        <section
          v-for="block in [
            { id: 'top-impressions', title: 'Les plus affichés', rows: stats.impressions.top, unit: 'affichage' },
            { id: 'top-online', title: 'Les plus vus en ligne', rows: stats.onlineViews.top, unit: 'vue' },
          ]"
          :key="block.id"
          :data-block="block.id"
        >
          <h3 class="mb-2 text-sm font-semibold">{{ block.title }}</h3>
          <p v-if="block.rows.length === 0" class="text-xs text-dim">Rien de compté pour l'instant.</p>
          <ol class="m-0 list-none p-0">
            <li
              v-for="(post, index) in block.rows"
              :key="post.id"
              class="mb-1.5 flex gap-2 border-b border-edge pb-1.5 text-xs last:border-b-0"
              :data-post="post.id"
            >
              <span class="w-5 flex-none text-right text-dim tabular-nums">{{ index + 1 }}</span>
              <div class="min-w-0 flex-1">
                <div class="font-medium">{{ topLine(post) }}</div>
                <div class="truncate text-dim" :title="post.text">{{ post.text || '(sans texte)' }}</div>
              </div>
              <span class="flex-none tabular-nums">{{ n(post.count) }} {{ block.unit }}{{ post.count > 1 ? 's' : '' }}</span>
            </li>
          </ol>
        </section>
      </div>

      <section class="mt-4 border-t border-edge pt-3.5" data-block="wallsio">
        <h3 class="mb-2 text-sm font-semibold">walls.io</h3>
        <Hint v-if="stats.wallsio == null" class="mb-0" data-role="wallsio-error">
          Chiffres walls.io indisponibles : {{ stats.wallsioError ?? 'raison inconnue' }}
        </Hint>
        <div v-else class="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-x-5 gap-y-4">
          <section
            v-for="block in [
              { id: 'wallsio-authors', title: 'Auteurs distincts (walls.io)', rows: stats.wallsio.authors.byNetwork },
              { id: 'wallsio-sentiment', title: 'Sentiment (walls.io)', rows: sentiment },
              { id: 'wallsio-languages', title: 'Langues', rows: stats.wallsio.languages },
            ]"
            :key="block.id"
            :data-block="block.id"
          >
            <h4 class="mb-2 text-xs font-semibold">{{ block.title }}</h4>
            <p v-if="block.rows.length === 0" class="text-xs text-dim">Rien à compter.</p>
            <div v-for="row in block.rows" :key="row.label" class="mb-1.5 text-xs" :data-row="row.label">
              <div class="mb-0.5 flex justify-between gap-2">
                <span class="truncate">{{ row.label }}</span>
                <span class="text-dim tabular-nums">{{ n(row.count) }}</span>
              </div>
              <div class="h-2 rounded-full bg-surface2">
                <div class="h-2 rounded-full bg-brand" :style="{ width: width(row, block.rows) }" />
              </div>
            </div>
          </section>
        </div>
        <p v-if="stats.wallsio" class="mt-2 mb-0 text-xs text-dim">
          {{ n(stats.wallsio.posts.total) }} posts sur walls.io ; sentiment et langues sur les
          {{ n(stats.wallsio.sampled) }} derniers, lus {{ timeAgo(stats.wallsio.fetchedAt) }}.
        </p>
        <p class="mt-1 mb-0 text-xs text-dim" data-role="interactions">
          Les likes, partages et réponses ne sont visibles que dans le tableau de bord walls.io.
        </p>
      </section>
    </template>
  </div>
</template>
