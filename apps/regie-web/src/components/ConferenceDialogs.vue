<script setup lang="ts">
import { ConfirmDialog } from '@cloudnord/components'
import { useConferenceStore } from '../stores/conference.js'
import { useKeyboardLayer } from '../stores/keyboard.js'

/**
 * Les trois questions qui se mettent en travers d'un démarrage ou d'une fin.
 *
 * Ensemble ici parce qu'elles s'enchaînent : le garde-fou d'avance ouvre celui
 * de l'enregistrement, qui lance la conférence. Éparpillées dans les panneaux,
 * l'ordre — qui est le fond du sujet — ne se lirait nulle part.
 *
 * Chacune pose une couche clavier, et ce n'est pas du confort : les raccourcis
 * de la page agissent sur la conférence, et un « r » réflexe pendant qu'on
 * demande s'il faut enregistrer basculerait la captation sous la question
 * elle-même. Une couche avale tout ce qu'elle n'a pas lié.
 */
const conference = useConferenceStore()

// Deux touches plutôt qu'une souris : on a le micro dans une main.
useKeyboardLayer(
  () => ({
    y: () => void conference.start(),
    // « o » comme oui : la moitié des opérateurs tape l'un, l'autre moitié
    // l'autre, et se tromper de lettre sur cette question-là coûte un talk.
    o: () => void conference.start(),
    n: () => {
      conference.tooEarlyOpen = false
    },
  }),
  () => conference.tooEarlyOpen,
)

useKeyboardLayer(
  () => ({
    y: () => void conference.end(),
    o: () => void conference.end(),
    n: () => {
      conference.endEarlyOpen = false
    },
  }),
  () => conference.endEarlyOpen,
)

/*
 * Rien de lié, et c'est le geste : trois issues nommées, dont aucune ne
 * s'atteint par réflexe. La couche est là pour ce qu'elle avale.
 */
useKeyboardLayer(() => ({}), () => conference.recordingOpen)
</script>

<template>
  <!--
    Entre deux créneaux, ou pendant une pause, la régie pilote la conférence qui
    arrive : c'est ce qu'on veut à 09:48 pour un talk de 09:50, et c'est un
    piège à 08:45 pour un talk de 09:50. Rien à l'écran ne distinguait les deux,
    et un « Commencer » de trop y écrivait un talk tenu de 08:45 à 08:45 — un
    créneau marqué comme s'étant déroulé alors que la salle était vide.
  -->
  <ConfirmDialog
    v-model:open="conference.tooEarlyOpen"
    tone="attention"
    title="Commencer très en avance ?"
    :detail="conference.tooEarlyDetail"
    cancel-label="Non"
    cancel-key="N"
    confirm-label="Commencer"
    confirm-key="Y"
    @confirm="conference.start()"
  />

  <!--
    Terminer n'est pas un geste anodin : la salle passe à « rien dans la salle »,
    les autres régies le voient, le compte à rebours saute à la conférence
    suivante. Le bouton est à côté de « Commencer », et c'est le genre de
    voisinage qui se paie une fois par événement.
  -->
  <ConfirmDialog
    v-model:open="conference.endEarlyOpen"
    tone="attention"
    title="Terminer en avance ?"
    :detail="conference.endEarlyDetail"
    cancel-label="Non"
    cancel-key="N"
    confirm-label="Terminer"
    confirm-key="Y"
    @confirm="conference.end()"
  />

  <ConfirmDialog
    v-model:open="conference.recordingOpen"
    tone="attention"
    title="Rien n'enregistre"
    detail="La conférence va commencer et OBS-B n'enregistre pas. Une VOD manquante ne se rattrape pas le soir."
    cancel-label="Annuler"
    confirm-label="Enregistrer et commencer"
    @confirm="conference.launch(true)"
  >
    <template #other>
      <button
        type="button"
        class="cursor-pointer rounded-lg border border-bord bg-surface2 px-3 py-2 text-[13px] font-semibold text-texte"
        @click="conference.launch(false)"
      >
        Commencer sans enregistrer
      </button>
    </template>
  </ConfirmDialog>
</template>
