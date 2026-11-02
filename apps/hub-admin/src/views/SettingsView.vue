<script setup lang="ts">
import { REGLAGES_SECTIONS, reglagesPath, type ReglagesSection } from '@conference-operator/contract'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import SectionMenu from '../components/SectionMenu.vue'
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
withDefaults(defineProps<{ section?: ReglagesSection }>(), { section: 'evenement' })

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

const entries = computed(() =>
  REGLAGES_SECTIONS.map((id) => ({ id, label: LABELS[id], path: reglagesPath(id), alerts: alerts.value[id] })),
)
</script>

<template>
  <div id="settings-view" class="grid gap-3.5 md:grid-cols-[176px_minmax(0,1fr)] md:items-start">
    <SectionMenu name="reglages" label="Sections des réglages" :entries="entries" :current="section" />

    <div class="min-w-0">
      <EvenementSection v-show="section === 'evenement'" data-section="evenement" />
      <SallesSection v-show="section === 'salles'" data-section="salles" />
      <PublicSection v-show="section === 'public'" data-section="public" />
      <VideoSection v-show="section === 'video'" data-section="video" />
      <SystemeSection v-show="section === 'systeme'" data-section="systeme" />
    </div>
  </div>
</template>
