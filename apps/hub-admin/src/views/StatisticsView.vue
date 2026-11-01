<script setup lang="ts">
import { Button, Empty, Hint, Panel } from '@conference-operator/components'
import type { StatistiqueTalk, WallStats } from '@conference-operator/contract'
import { fileSize } from '@conference-operator/format'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref } from 'vue'
import { dayKeyOf, dayOptions } from '../stores/days.js'
import { MONTAGE_STATES, montagePath } from '../stores/montage.js'
import { useSessionStore } from '../stores/session.js'
import { RETARD_NOTABLE_MS, synthese, talksCsv, useStatistiquesStore } from '../stores/statistiques.js'

/**
 * The edition in figures, for the assessment afterwards.
 *
 * Each section says how many talks its average rests on: a rush that never came
 * home is missing from the sound figures, and must not pass for a good one.
 */
const store = useStatistiquesStore()
const { data } = storeToRefs(store)
const session = useSessionStore()

const wall = ref<WallStats | null>(null)
onMounted(() => {
  void store.load().catch(() => undefined)
  void Promise.resolve()
    .then(() => session.client.rpc.wall.stats())
    .then((stats) => { wall.value = stats })
    .catch(() => undefined)
})

const room = ref('')
const day = ref('')
const zone = computed(() => data.value?.timezone ?? 'Europe/Paris')
const rooms = computed(() => {
  const named = new Map<string, string>()
  for (const talk of data.value?.talks ?? []) if (talk.roomId != null) named.set(talk.roomId, talk.roomName ?? talk.roomId)
  return [...named].map(([id, name]) => ({ id, name }))
})
const days = computed(() => dayOptions((data.value?.talks ?? []).map((talk) => talk.startsAt), zone.value))
const talks = computed(() =>
  (data.value?.talks ?? []).filter(
    (talk) =>
      (room.value === '' || talk.roomId === room.value) &&
      (day.value === '' || dayKeyOf(talk.startsAt, zone.value) === day.value),
  ),
)
const s = computed(() => synthese(talks.value))

const minutes = (ms: number | null) => {
  if (ms == null) return '—'
  const rounded = Math.round(Math.abs(ms) / 60_000)
  return rounded === 0 ? '0 min' : `${ms > 0 ? '+' : '−'}${rounded} min`
}
const hours = (ms: number) => `${Math.floor(ms / 3_600_000)} h ${String(Math.round((ms % 3_600_000) / 60_000)).padStart(2, '0')}`
const db = (value: number | null, unit: string) => (value == null ? '—' : `${value.toFixed(1).replace('.', ',')} ${unit}`)
const hour = (iso: string) =>
  new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: zone.value }).format(new Date(iso))

const RUSH: Record<StatistiqueTalk['rush'], { label: string; tone: string }> = {
  rentre: { label: 'rentré', tone: 'text-ok' },
  'en-cours': { label: 'en cours', tone: 'text-brand' },
  echec: { label: 'en échec', tone: 'text-alert' },
  manquant: { label: 'manquant', tone: 'text-warn' },
  'sans-objet': { label: 'sans captation', tone: 'text-dim' },
}

type Sort = 'startsAt' | 'retardMs' | 'depassementMs' | 'lufs' | 'alertesSaturation'
const sort = ref<Sort>('startsAt')
const ascending = ref(true)
function sortBy(column: Sort): void {
  if (sort.value === column) ascending.value = !ascending.value
  else {
    sort.value = column
    ascending.value = column === 'startsAt'
  }
}
const sorted = computed(() => {
  const direction = ascending.value ? 1 : -1
  return [...talks.value].sort((a, b) => {
    const left = a[sort.value]
    const right = b[sort.value]
    // What was not measured stays last, whichever way the column is read.
    if (left == null) return right == null ? 0 : 1
    if (right == null) return -1
    return left < right ? -direction : left > right ? direction : 0
  })
})
const ariaSort = (column: Sort) => (sort.value !== column ? 'none' : ascending.value ? 'ascending' : 'descending')

function exportCsv(): void {
  const url = URL.createObjectURL(new Blob([talksCsv(sorted.value)], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'statistiques-talks.csv'
  link.click()
  URL.revokeObjectURL(url)
}

const FILTER = 'rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text'
const ROW = 'flex items-baseline justify-between gap-3 border-t border-edge py-1.5 text-sm first:border-t-0'
const HEAD = 'cursor-pointer pr-3 pb-2 text-left font-semibold whitespace-nowrap hover:text-text'
</script>

<template>
  <div id="statistics-view" class="flex flex-col gap-3.5">
    <div class="flex flex-wrap items-center gap-2">
      <select id="stats-room" v-model="room" :class="FILTER" aria-label="Salle">
        <option value="">Toutes les salles</option>
        <option v-for="option in rooms" :key="option.id" :value="option.id">{{ option.name }}</option>
      </select>
      <select id="stats-day" v-model="day" :class="FILTER" aria-label="Jour">
        <option value="">Tous les jours</option>
        <option v-for="option in days" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
      <Button id="stats-export" size="small" class="ml-auto" :disabled="talks.length === 0" @click="exportCsv">Exporter en CSV</Button>
    </div>

    <Empty v-if="data == null">Lecture des chiffres…</Empty>
    <Empty v-else-if="talks.length === 0">Aucun talk pour ce choix de salle et de jour.</Empty>

    <template v-else>
      <dl id="stats-bilan" class="flex flex-wrap gap-x-10 gap-y-3 border-b border-edge pb-3.5">
        <div><dt class="text-xs text-dim">Talks tenus</dt><dd class="text-2xl font-semibold tabular-nums">{{ s.tenus }} <span class="text-sm font-normal text-dim">/ {{ s.prevus }}</span></dd></div>
        <div><dt class="text-xs text-dim">Retard moyen</dt><dd class="text-2xl font-semibold tabular-nums">{{ minutes(s.retard.valeur) }}</dd></div>
        <div><dt class="text-xs text-dim">Rushs rentrés</dt><dd class="text-2xl font-semibold tabular-nums">{{ s.rushRentres }} <span class="text-sm font-normal text-dim">/ {{ s.rushAttendus }}</span></dd></div>
        <div><dt class="text-xs text-dim">Vidéos prêtes</dt><dd class="text-2xl font-semibold tabular-nums">{{ s.videos }} <span class="text-sm font-normal text-dim">· {{ hours(s.videoMs) }}</span></dd></div>
      </dl>

      <Hint v-if="s.rushManquants > 0" id="stats-manquants" class="mt-0 text-warn">
        {{ s.rushManquants }} rush{{ s.rushManquants > 1 ? 's' : '' }} jamais rentré{{ s.rushManquants > 1 ? 's' : '' }} : ces talks manquent aux chiffres du son et des vidéos.
      </Hint>

      <div class="grid grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-3.5">
        <Panel title="Conférences">
          <div :class="ROW"><span>Retard moyen au début</span><strong class="tabular-nums">{{ minutes(s.retard.valeur) }}</strong></div>
          <div :class="ROW"><span>Talks partis avec {{ RETARD_NOTABLE_MS / 60_000 }} min ou plus</span><strong class="tabular-nums">{{ s.enRetard }}</strong></div>
          <div :class="ROW"><span>Écart moyen à la fin</span><strong class="tabular-nums">{{ minutes(s.depassement.valeur) }}</strong></div>
          <p class="mt-1.5 text-xs text-dim">Sur {{ s.retard.sur }} talks lancés à la main<template v-if="s.autos > 0"> ; {{ s.autos }} lancé{{ s.autos > 1 ? 's' : '' }} par la règle horaire, sans compter</template>.</p>
        </Panel>

        <Panel title="Captation">
          <div :class="ROW"><span>Volume rentré</span><strong class="tabular-nums">{{ fileSize(s.octets) }}</strong></div>
          <div :class="ROW"><span>Niveau moyen des rushs</span><strong class="tabular-nums">{{ db(s.lufs.valeur, 'LUFS') }}</strong></div>
          <div :class="ROW"><span>Pic le plus haut</span><strong class="tabular-nums">{{ db(s.piresPics, 'dB') }}</strong></div>
          <div :class="ROW"><span>Alertes saturation / silence</span><strong class="tabular-nums">{{ s.saturation }} / {{ s.silence }}</strong></div>
          <p class="mt-1.5 text-xs text-dim">Niveaux mesurés sur {{ s.lufs.sur }} talks. Les alertes viennent de la régie : elles disent ce qu'OBS a vu, pas ce que le rush a gardé.</p>
        </Panel>

        <Panel title="Vidéos">
          <div :class="ROW"><span>Prêtes</span><strong class="tabular-nums">{{ s.videos }}</strong></div>
          <div :class="ROW"><span>Coupes à valider</span><strong class="tabular-nums">{{ s.aValider }}</strong></div>
          <div :class="ROW"><span>En échec</span><strong class="tabular-nums" :class="s.enEchec > 0 ? 'text-alert' : ''">{{ s.enEchec }}</strong></div>
          <div :class="ROW"><span>Confiance haute / moyenne / basse</span><strong class="whitespace-nowrap tabular-nums">{{ s.confiance.haute }} / {{ s.confiance.moyenne }} / {{ s.confiance.basse }}</strong></div>
          <div :class="ROW"><span>Diffusion accordée / refusée / inconnue</span><strong class="whitespace-nowrap tabular-nums">{{ s.consentements.accordes }} / {{ s.consentements.refuses }} / {{ s.consentements.inconnus }}</strong></div>
        </Panel>

        <Panel title="Public">
          <template v-if="wall != null">
            <div :class="ROW"><span>Posts publiés sur le mur</span><strong class="tabular-nums">{{ wall.posts.total }}</strong></div>
            <div :class="ROW"><span>Passages sur les écrans</span><strong class="tabular-nums">{{ wall.impressions.total }}</strong></div>
            <div :class="ROW"><span>Vues sur la page publique</span><strong class="tabular-nums">{{ wall.onlineViews.total }}</strong></div>
          </template>
          <p v-else class="text-sm text-dim">Statistiques du mur non disponibles avec ce compte.</p>
          <div :class="ROW"><span>Questions du public</span><strong class="tabular-nums">{{ data.questions }}</strong></div>
          <p class="mt-1.5 text-xs text-dim">Toute l'édition, quels que soient les filtres. Les notes OpenFeedback ne sont pas sur le hub.</p>
        </Panel>

        <Panel title="Sponsors">
          <div :class="ROW"><span>Au programme</span><strong class="tabular-nums">{{ data.sponsors.total }}</strong></div>
          <div v-for="palier in data.sponsors.paliers" :key="palier.nom" :class="ROW"><span>{{ palier.nom }}</span><span class="tabular-nums">{{ palier.nombre }}</span></div>
        </Panel>

        <Panel title="Exploitation">
          <div :class="ROW"><span>Actions au journal</span><strong class="tabular-nums">{{ data.exploitation.actions }}</strong></div>
          <div :class="ROW"><span>Actions refusées</span><strong class="tabular-nums">{{ data.exploitation.refusees }}</strong></div>
          <p class="mt-1.5 text-xs text-dim">Le journal purge ses anciennes entrées.</p>
        </Panel>
      </div>

      <Panel title="Par talk">
        <div class="overflow-x-auto">
          <table id="stats-talks" class="w-full border-collapse text-[13px]">
            <thead>
              <tr class="text-[11px] tracking-[.08em] text-dim uppercase">
                <th :class="HEAD" :aria-sort="ariaSort('startsAt')" @click="sortBy('startsAt')">Heure</th>
                <th class="pr-3 pb-2 text-left font-semibold">Talk</th>
                <th class="pr-3 pb-2 text-left font-semibold">Salle</th>
                <th :class="HEAD" :aria-sort="ariaSort('retardMs')" data-sort="retard" @click="sortBy('retardMs')">Retard</th>
                <th :class="HEAD" :aria-sort="ariaSort('depassementMs')" @click="sortBy('depassementMs')">Fin</th>
                <th class="pr-3 pb-2 text-left font-semibold">Rush</th>
                <th :class="HEAD" :aria-sort="ariaSort('lufs')" @click="sortBy('lufs')">LUFS</th>
                <th :class="HEAD" :aria-sort="ariaSort('alertesSaturation')" @click="sortBy('alertesSaturation')">Saturation</th>
                <th class="pb-2 text-left font-semibold">Montage</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="talk in sorted" :key="talk.sessionId" :data-talk="talk.sessionId">
                <td class="border-t border-edge py-2 pr-3 tabular-nums text-dim">{{ hour(talk.startsAt) }}</td>
                <td class="border-t border-edge py-2 pr-3">{{ talk.title }}</td>
                <td class="border-t border-edge py-2 pr-3 whitespace-nowrap text-dim">{{ talk.roomName ?? '—' }}</td>
                <td class="border-t border-edge py-2 pr-3 whitespace-nowrap tabular-nums" :class="(talk.retardMs ?? 0) >= RETARD_NOTABLE_MS ? 'text-warn' : ''" :title="talk.auto ? 'Lancé par la règle horaire' : undefined">{{ talk.auto ? 'auto' : minutes(talk.retardMs) }}</td>
                <td class="border-t border-edge py-2 pr-3 whitespace-nowrap tabular-nums">{{ minutes(talk.depassementMs) }}</td>
                <td class="border-t border-edge py-2 pr-3 whitespace-nowrap" :class="RUSH[talk.rush].tone">{{ RUSH[talk.rush].label }}</td>
                <td class="border-t border-edge py-2 pr-3 whitespace-nowrap tabular-nums">{{ talk.lufs == null ? '—' : talk.lufs.toFixed(1).replace('.', ',') }}</td>
                <td class="border-t border-edge py-2 pr-3 tabular-nums">{{ talk.alertesSaturation }}</td>
                <td class="border-t border-edge py-2 whitespace-nowrap">
                  <a v-if="talk.montages.length > 0" :href="montagePath(talk.sessionId)" class="underline underline-offset-2" :class="MONTAGE_STATES[talk.montages.at(-1)!]?.tone">{{ MONTAGE_STATES[talk.montages.at(-1)!]?.label ?? talk.montages.at(-1) }}</a>
                  <span v-else class="text-dim">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>
    </template>
  </div>
</template>
