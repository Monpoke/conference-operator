<script setup lang="ts">
import AgendaPanel from '../components/boucle/AgendaPanel.vue'
import AnnoncesPanel from '../components/boucle/AnnoncesPanel.vue'
import ConduitePanel from '../components/boucle/ConduitePanel.vue'
import DureesPanel from '../components/boucle/DureesPanel.vue'
import FeedbacksPanel from '../components/boucle/FeedbacksPanel.vue'
import IdentityPanel from '../components/boucle/IdentityPanel.vue'
import MerciPanel from '../components/boucle/MerciPanel.vue'
import MessagesPanel from '../components/boucle/MessagesPanel.vue'
import PlanningsPanel from '../components/boucle/PlanningsPanel.vue'
import PreviewPanel from '../components/boucle/PreviewPanel.vue'
import SponsorPagesPanel from '../components/boucle/SponsorPagesPanel.vue'
import WallsioPanel from '../components/boucle/WallsioPanel.vue'

/**
 * The welcome loop's content: what the room screens show between talks.
 *
 * One panel per section of the setting, each with its own « Enregistrer »: the
 * hub merges them section by section, and a panel being edited is not
 * overwritten by the refresh — see `useDraft`. Which scenes run at all is
 * decided in Réglages, with the other screens. The preview, on top and across
 * the whole width, is the room screen itself, reloaded after every save.
 */
</script>

<template>
  <div id="boucle-view" class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] gap-3.5 [&>*]:min-w-0">
    <div class="col-span-full">
      <PreviewPanel />
    </div>
    <DureesPanel />
    <IdentityPanel />
    <MessagesPanel />
    <AnnoncesPanel />
    <MerciPanel />
    <AgendaPanel />
    <PlanningsPanel />
    <SponsorPagesPanel />
    <WallsioPanel />
    <ConduitePanel />
    <FeedbacksPanel />
  </div>
</template>
