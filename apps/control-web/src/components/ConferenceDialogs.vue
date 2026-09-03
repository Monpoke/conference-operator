<script setup lang="ts">
import { ConfirmDialog } from '@cloudnord/components'
import { useTalkStore } from '../stores/conference.js'
import { useKeyboardLayer } from '../stores/keyboard.js'

/**
 * Les quatre questions qui se mettent en travers d'un démarrage ou d'une fin.
 *
 * Ensemble ici parce qu'elles s'enchaînent, deux par deux : le garde-fou
 * d'avance ouvre celui de l'enregistrement, qui lance la conférence ; celui de
 * la fin anticipée ouvre celui de la captation, qui la termine. Éparpillées
 * dans les panneaux, l'ordre — qui est le fond du sujet — ne se lirait nulle
 * part.
 *
 * Chacune pose une couche clavier vide, et ce n'est pas du confort : les
 * raccourcis de la page agissent sur la conférence, et un « r » réflexe pendant
 * qu'on demande s'il faut enregistrer basculerait la captation sous la question
 * elle-même. Une couche avale tout ce qu'elle n'a pas lié — et celles-ci ne
 * lient rien, `ConfirmDialog` s'occupant lui-même du `Y` et du `N` qu'il
 * imprime.
 */
const conference = useTalkStore()

/*
 * Des couches vides, et c'est tout ce qu'il faut.
 *
 * `Y` et `N` sont désormais liés par `ConfirmDialog` lui-même, avec le libellé
 * qu'il imprime : les deux ne peuvent plus diverger, et les quatre questions
 * répondent au clavier de la même façon — ce qui n'était le cas que de deux
 * d'entre elles quand chaque appelant câblait les siennes.
 *
 * La couche reste, pour ce qu'elle **avale** : un « r » réflexe pendant qu'on
 * demande s'il faut enregistrer basculerait la captation sous la question
 * elle-même, et un « l » mettrait la salle à l'antenne. Elle ne lie plus rien.
 */
useKeyboardLayer(() => ({}), () => conference.tooEarlyOpen)
useKeyboardLayer(() => ({}), () => conference.endEarlyOpen)
useKeyboardLayer(() => ({}), () => conference.recordingOpen)
useKeyboardLayer(() => ({}), () => conference.stopRecordingOpen)
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
    tone="warn"
    title="Commencer très en avance ?"
    :detail="conference.tooEarlyDetail"
    cancel-label="Non"
    confirm-label="Commencer"
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
    tone="warn"
    title="Terminer en avance ?"
    :detail="conference.endEarlyDetail"
    cancel-label="Non"
    confirm-label="Terminer"
    @confirm="conference.end()"
  />

  <!--
    Le pendant de « Rien n'enregistre », et il couvre l'oubli que celui-ci
    laisse passer : une captation qu'on n'arrête pas ne se voit nulle part. Elle
    court pendant la pause, le talk suivant s'écrit dans le même fichier, et le
    garde-fou du démarrage se tait puisqu'un enregistrement tourne. Le prix ne
    se découvre qu'au editing, quand la salle est démontée.
  -->
  <ConfirmDialog
    v-model:open="conference.stopRecordingOpen"
    tone="warn"
    title="La captation tourne encore"
    :detail="conference.stopRecordingDetail"
    cancel-label="Annuler"
    confirm-label="Arrêter et terminer"
    @confirm="conference.finish(true)"
  >
    <template #other>
      <!--
        L'issue du talk enregistré d'une traite, questions du public comprises,
        qui déborde du créneau. Elle est nommée, pas cachée : la retirer
        obligerait à annuler, terminer, puis se souvenir d'arrêter plus tard.
      -->
      <button
        type="button"
        class="cursor-pointer rounded-lg border border-edge bg-surface2 px-3 py-2 text-[13px] font-semibold text-text"
        @click="conference.finish(false)"
      >
        Terminer sans arrêter
      </button>
    </template>
  </ConfirmDialog>

  <ConfirmDialog
    v-model:open="conference.recordingOpen"
    tone="warn"
    title="Rien n'enregistre"
    detail="La conférence va commencer et OBS-B n'enregistre pas. Une VOD manquante ne se rattrape pas le soir."
    cancel-label="Annuler"
    confirm-label="Enregistrer et commencer"
    @confirm="conference.launch(true)"
  >
    <template #other>
      <button
        type="button"
        class="cursor-pointer rounded-lg border border-edge bg-surface2 px-3 py-2 text-[13px] font-semibold text-text"
        @click="conference.launch(false)"
      >
        Commencer sans enregistrer
      </button>
    </template>
  </ConfirmDialog>
</template>
