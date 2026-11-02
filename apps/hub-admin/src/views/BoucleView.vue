<script setup lang="ts">
import { BOUCLE_SECTIONS, bouclePath, type BoucleSection } from '@conference-operator/contract'
import SectionMenu from '../components/SectionMenu.vue'
import AgendaPanel from '../components/boucle/AgendaPanel.vue'
import AnnoncesPanel from '../components/boucle/AnnoncesPanel.vue'
import ConduitePanel from '../components/boucle/ConduitePanel.vue'
import DureesPanel from '../components/boucle/DureesPanel.vue'
import FeedbacksPanel from '../components/boucle/FeedbacksPanel.vue'
import GitPanel from '../components/boucle/GitPanel.vue'
import IdentityPanel from '../components/boucle/IdentityPanel.vue'
import MerciPanel from '../components/boucle/MerciPanel.vue'
import MessagesPanel from '../components/boucle/MessagesPanel.vue'
import PlanningsPanel from '../components/boucle/PlanningsPanel.vue'
import PreviewPanel from '../components/boucle/PreviewPanel.vue'
import SponsorPagesPanel from '../components/boucle/SponsorPagesPanel.vue'
import ThemePanel from '../components/boucle/ThemePanel.vue'
import WallsioPanel from '../components/boucle/WallsioPanel.vue'

/**
 * The welcome loop's content: what the room screens show between talks.
 *
 * One panel per section of the setting, each with its own « Enregistrer »: the
 * hub merges them section by section, and a panel being edited is not
 * overwritten by the refresh — see `useDraft`. Which scenes run at all is
 * decided in Réglages, with the other screens.
 *
 * One address per group of panels. They all stay mounted, so a draft survives a
 * change of section. The preview is outside them: it is the room screen itself,
 * reloaded after every save, and it stays in sight whatever is being edited.
 */
withDefaults(defineProps<{ section?: BoucleSection }>(), { section: 'apparence' })

const LABELS: Record<BoucleSection, string> = {
  apparence: 'Apparence',
  deroule: 'Déroulé',
  contenus: 'Contenus',
  sponsors: 'Sponsors',
}
const entries = BOUCLE_SECTIONS.map((id) => ({ id, label: LABELS[id], path: bouclePath(id) }))
</script>

<template>
  <div
    id="boucle-view"
    class="grid gap-3.5 md:grid-cols-[176px_minmax(0,1fr)] md:items-start lg:grid-cols-[176px_minmax(0,1fr)_minmax(0,1fr)]"
  >
    <SectionMenu name="boucle" label="Sections de la boucle" :entries="entries" :current="section" />

    <div class="min-w-0 md:col-start-2 lg:sticky lg:top-3 lg:col-start-3 lg:row-start-1">
      <PreviewPanel />
    </div>

    <div class="min-w-0 md:col-start-2 lg:row-start-1">
      <div v-show="section === 'apparence'" data-section="apparence" class="flex flex-col gap-3.5">
        <ThemePanel />
        <GitPanel />
        <IdentityPanel />
      </div>
      <div v-show="section === 'deroule'" data-section="deroule" class="flex flex-col gap-3.5">
        <DureesPanel />
        <ConduitePanel />
      </div>
      <div v-show="section === 'contenus'" data-section="contenus" class="flex flex-col gap-3.5">
        <MessagesPanel />
        <AnnoncesPanel />
        <MerciPanel />
        <AgendaPanel />
        <PlanningsPanel />
        <FeedbacksPanel />
        <WallsioPanel />
      </div>
      <div v-show="section === 'sponsors'" data-section="sponsors" class="flex flex-col gap-3.5">
        <SponsorPagesPanel />
      </div>
    </div>
  </div>
</template>
