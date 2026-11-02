<script setup lang="ts">
import { REGLAGES_SECTIONS, reglagesPath, type ReglagesSection } from '@conference-operator/contract'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import EvenementSection from '../components/reglages/EvenementSection.vue'
import PublicSection from '../components/reglages/PublicSection.vue'
import SallesSection from '../components/reglages/SallesSection.vue'
import SystemeSection from '../components/reglages/SystemeSection.vue'
import VideoSection from '../components/reglages/VideoSection.vue'
import { settingsAlerts } from '../composables/settingsAlerts.js'
import { useIntegrationsStore } from '../stores/integrations.js'
import { useSettingsStore } from '../stores/settings.js'
import { useWallsIoStore } from '../stores/wallsio.js'

/**
 * What is set once, and holds for the day: one address per section.
 *
 * The sections all stay mounted and only the current one shows. A key typed in
 * Salles must survive a look at Vidéo, and the refresh rule stays where it was:
 * no field rewrites itself while somebody is typing in it (`useSeededField`).
 */
const props = withDefaults(defineProps<{ section?: ReglagesSection }>(), { section: 'evenement' })

const LABELS: Record<ReglagesSection, string> = {
  evenement: 'Événement',
  salles: 'Salles',
  public: 'Public',
  video: 'Vidéo',
  systeme: 'Système',
}

const store = useSettingsStore()
const { settings, images, streams, urgentPinSet, storage } = storeToRefs(store)
const { integrations } = storeToRefs(useIntegrationsStore())
const { status: wallsIo } = storeToRefs(useWallsIoStore())

const alerts = computed(() =>
  settingsAlerts({
    loaded: settings.value != null,
    failedImages: images.value.failed.length,
    streams: streams.value,
    urgentPinSet: urgentPinSet.value,
    wallsIoError: wallsIo.value?.hasToken === true ? (wallsIo.value.lastError ?? null) : null,
    storage: storage.value,
    integrations: integrations.value,
  }),
)

/** On a phone the menu is one line that scrolls: keep the current section in view. */
const menu = ref<HTMLElement | null>(null)
function revealCurrent(): void {
  void nextTick(() => {
    menu.value
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView?.({ inline: 'center', block: 'nearest' })
  })
}
onMounted(revealCurrent)
// The badges arrive after the first render and widen the menu: reveal again then.
watch([() => props.section, () => Object.values(alerts.value).flat().length], revealCurrent)
</script>

<template>
  <div id="settings-view" class="grid gap-3.5 md:grid-cols-[176px_minmax(0,1fr)] md:items-start">
    <nav
      ref="menu"
      aria-label="Sections des réglages"
      class="flex gap-1 max-md:-mx-1 max-md:overflow-x-auto max-md:px-1 max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden md:sticky md:top-3 md:flex-col"
    >
      <RouterLink
        v-for="entry in REGLAGES_SECTIONS"
        :id="`reglages-${entry}`"
        :key="entry"
        :to="reglagesPath(entry)"
        class="flex shrink-0 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[13px] whitespace-nowrap"
        :class="section === entry ? 'border-edge bg-surface2 text-text' : 'border-transparent text-dim'"
        :aria-current="section === entry ? 'page' : undefined"
      >
        {{ LABELS[entry] }}
        <span
          v-if="alerts[entry].length > 0"
          :data-alerts="entry"
          :title="alerts[entry].join('\n')"
          :aria-label="alerts[entry].join(' ; ')"
          class="rounded-full bg-alert/15 px-1.5 text-[11px] font-semibold text-alert tabular-nums"
        >{{ alerts[entry].length }}</span>
      </RouterLink>
    </nav>

    <div class="max-w-4xl min-w-0">
      <EvenementSection v-show="section === 'evenement'" data-section="evenement" />
      <SallesSection v-show="section === 'salles'" data-section="salles" />
      <PublicSection v-show="section === 'public'" data-section="public" />
      <VideoSection v-show="section === 'video'" data-section="video" />
      <SystemeSection v-show="section === 'systeme'" data-section="systeme" />
    </div>
  </div>
</template>
