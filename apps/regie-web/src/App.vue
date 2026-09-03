<script setup lang="ts">
import { Toaster } from '@cloudnord/components'
import { computed, onBeforeUnmount, onMounted, useTemplateRef, watch, watchEffect } from 'vue'
import CapturePanel from './components/CapturePanel.vue'
import ConferenceDialogs from './components/ConferenceDialogs.vue'
import ConferencePanel from './components/ConferencePanel.vue'
import ConfigDialog from './components/ConfigDialog.vue'
import ConsultDialog from './components/ConsultDialog.vue'
import DiagnosticsPanel from './components/DiagnosticsPanel.vue'
import LevelMeters from './components/LevelMeters.vue'
import MessagePanel from './components/MessagePanel.vue'
import NotificationStack from './components/NotificationStack.vue'
import PairingVeil from './components/PairingVeil.vue'
import ProjectionPanel from './components/ProjectionPanel.vue'
import RegieHeader from './components/RegieHeader.vue'
import RoomsStrip from './components/RoomsStrip.vue'
import SalleSelect from './components/SalleSelect.vue'
import ScreenPanel from './components/ScreenPanel.vue'
import SignInScreen from './components/SignInScreen.vue'
import VerrouBanner from './components/VerrouBanner.vue'
import VerrouVeil from './components/VerrouVeil.vue'
import VodDialog from './components/VodDialog.vue'
import { useActionsStore } from './stores/actions.js'
import { useAudioStore } from './stores/audio.js'
import { useClockStore } from './stores/clock.js'
import { useConfigStore } from './stores/config.js'
import { useConsultStore } from './stores/consult.js'
import { useHostStore } from './stores/host.js'
import { useKeyboardLayer } from './stores/keyboard.js'
import { usePorteStore } from './stores/porte.js'
import { useProgramsStore } from './stores/programs.js'
import { useRoomStore } from './stores/room.js'
import { useSessionStore } from './stores/session.js'
import { useVerrouStore } from './stores/verrou.js'
import { useVodStore } from './stores/vod.js'

/**
 * La régie, servie de deux endroits.
 *
 * **Locale** — le poste de salle : trois colonnes qui ne défilent pas, tout
 * visible, rien à chercher. C'est la disposition visée, et au-dessous de
 * 1024 px elle retombe sur une colonne défilante faute de mieux.
 *
 * **Distante** — le hub, sur un téléphone : une colonne, et seulement les
 * panneaux dont le hub a la matière. Pas une version réduite de la première par
 * masquage, mais une disposition à part : la fenêtre d'un poste et l'écran d'un
 * pouce ne se rangent pas de la même façon, et prétendre le contraire donne une
 * page qui n'est bien nulle part.
 *
 * Ce qui n'est **pas** offert à distance : les marqueurs, la VOD, le ⚙, les
 * vumètres, le diagnostic. Ce sont des gestes de poste, ou des gestes dont le
 * hub n'a pas la matière — les monter vides serait pire que de ne pas les
 * monter.
 */
const room = useRoomStore()
const porte = usePorteStore()
const session = useSessionStore()
const verrou = useVerrouStore()
const clock = useClockStore()
const host = useHostStore()
const audio = useAudioStore()
const actions = useActionsStore()
const consult = useConsultStore()
const config = useConfigStore()
const programs = useProgramsStore()
const vod = useVodStore()

const capture = useTemplateRef<InstanceType<typeof CapturePanel>>('capture')

/** Écouteurs posés seulement à distance ; rendus pour être retirés. */
let retirerHistorique: (() => void) | null = null
let retirerDepart: (() => void) | null = null

onMounted(() => {
  clock.start()
  room.connect()
  /*
   * Le vumètre et la charge de l'hôte n'existent qu'en local.
   *
   * Les deux sont servis par la machine de salle, sur son origine : les ouvrir
   * depuis un téléphone ferait deux requêtes qui échouent en boucle contre le
   * hub, pour des panneaux que la disposition mobile ne monte pas.
   */
  if (!porte.distante) {
    audio.connect()
    host.start()
    return
  }
  retirerHistorique = porte.suivreHistorique()
  retirerDepart = verrou.libererAuDepart()
})

onBeforeUnmount(() => {
  retirerHistorique?.()
  retirerDepart?.()
  host.stop()
  audio.disconnect()
  room.disconnect()
  clock.stop()
})

const payload = computed(() => room.payload)

/**
 * Le titre suit l'événement, pas la coquille.
 *
 * La coquille en pose un au rendu, ce qui évite le flash — mais il est figé à
 * cet instant-là. C'est la même machine qui servira l'édition suivante, le nom
 * peut changer à un sync en pleine journée, et la barre de fenêtre est le
 * premier endroit où un nom périmé se remarque. Un opérateur qui aligne trois
 * fenêtres de salles n'a que ça pour les distinguer.
 */
watchEffect(() => {
  const nom = payload.value?.eventIdentity?.name
  if (nom == null || nom === '') return
  /*
   * À distance, la salle passe devant l'événement.
   *
   * Un opérateur qui aligne trois onglets sur trois salles n'a que le titre
   * pour les distinguer, et l'événement est le même pour les trois.
   */
  document.title = porte.distante
    ? `${payload.value?.roomName ?? 'Régie'} — ${nom}`
    : `Régie — ${nom}`
})

/*
 * Les programmes des salles voisines suivent l'empreinte, pas le flux.
 *
 * La régie reçoit un état toutes les quelques secondes ; relire une dizaine de
 * programmes à chaque fois coûterait autant de requêtes pour une réponse
 * identique. Le store ne recharge que si l'empreinte a changé — l'effet se
 * redéclenche à chaque charge utile, et c'est `load` qui s'arrête tout de suite.
 */
watchEffect(() => {
  const state = payload.value?.state
  // Servis par la machine de salle : hors de portée d'un téléphone, et le
  // panneau qui les lit n'est pas monté à distance.
  if (state != null && !porte.distante) void programs.load(state.contentHash, state.roomId)
})

/**
 * Les rôles de scène que la salle a réellement mappés.
 *
 * Servis par le hub et non déduits d'une constante : une salle sans `RELAY`
 * configuré n'affiche pas le bouton, exactement comme en régie de salle. En
 * local, le panneau garde sa propre règle — la configuration est sous sa main.
 */
const rolesDistants = computed(() =>
  Object.keys(payload.value?.diagnostics?.config?.sceneRoles.A ?? {}),
)

/**
 * Une machine non appairée n'a rien à piloter.
 *
 * Le voile n'est pas posé « par-dessus » la page : il la remplace. `paired` est
 * la seule valeur qui le lève, et l'absence de bloc `pairing` aussi — une salle
 * déjà liée n'en reçoit pas.
 */
const pairingRequired = computed(
  () => payload.value?.pairing != null && payload.value.pairing.status !== 'paired',
)

/**
 * La configuration passe devant si la salle n'est pas prête.
 *
 * Au démarrage du poste et **une fois la machine appairée** : avant, il n'y a
 * ni salle, ni configuration, et le voile occupe de toute façon l'écran. C'est
 * le premier instant où le panneau a quelque chose à montrer.
 *
 * Le store tient le reste : le verdict, pris sans attendre, et le fait que cela
 * n'arrive qu'une fois par chargement de page.
 *
 * Rien à distance : le panneau de configuration n'y est pas monté, et un
 * téléphone n'est pas l'endroit d'où l'on branche un OBS.
 */
watch(
  [() => porte.distante, pairingRequired, payload],
  ([distante, appairageRequis, recu]) => {
    if (distante || appairageRequis || recu == null) return
    config.verifierAuDemarrage()
  },
  { immediate: true },
)

/**
 * Les raccourcis de la page, sur la couche du fond.
 *
 * Dans une salle sombre, viser un bouton coûte plus cher qu'appuyer sur une
 * touche. Toute modale posera une couche par-dessus celle-ci et les avalera :
 * c'est ce qui empêche un « r » réflexe de lancer une captation sous une
 * question ouverte.
 */
useKeyboardLayer(
  () => ({
    l: () => void actions.act({ action: 'scene.set', role: 'LIVE' }),
    h: () => void actions.act({ action: 'scene.set', role: 'HOLD' }),
    r: () => capture.value?.toggleRecording(),
    m: () => capture.value?.mark(),
    /*
     * Les deux repères de editing ont leur touche, comme la captation.
     *
     * Ce sont des gestes qu'on fait pendant qu'on regarde la salle, pas
     * l'écran : l'orateur commence, l'orateur finit. Passer par le champ de
     * libellé pour taper « Début » ferait rater l'instant qu'on voulait
     * marquer — et c'est l'instant, ici, qui est toute l'information.
     */
    d: () => capture.value?.repere('debut'),
    f: () => capture.value?.repere('fin'),
    s: () => consult.show('salles'),
    p: () => consult.show('programme'),
  }),
  /*
   * Rien sous le voile d'appairage, et rien sur un téléphone.
   *
   * La page d'origine gardait ses raccourcis vivants derrière le voile — son
   * écouteur était global et le voile n'était qu'un attribut sur le `<body>`.
   * Taper « l » sur une machine non appairée postait une bascule de scène vers
   * un OBS qu'elle n'a pas, et récoltait un échec rouge pour toute réponse.
   *
   * À distance, `m`, `d`, `f`, `s` et `p` visent des panneaux absents — et un clavier
   * logiciel qui s'ouvre sur un champ de recherche déclencherait le reste.
   */
  () => !pairingRequired.value && !porte.distante,
)
</script>

<template>
  <!--
    À distance, trois écrans avant la régie, dans cet ordre : se connecter,
    choisir une salle, la piloter. Chacun remplace le précédent — un pupitre
    tenu d'une main n'a pas de place pour deux choses à la fois.
  -->
  <template v-if="porte.distante">
    <SignInScreen v-if="!session.signedIn" />
    <SalleSelect v-else-if="porte.choixDeSalle" />

    <template v-else>
      <VerrouBanner :now-ms="room.now" />

      <!--
        Le voile de verrou par-dessus, et pas à la place.

        L'état de la salle reste lisible en dessous : venir regarder une salle
        qu'un collègue pilote est un usage normal — c'est même ce que fait
        quelqu'un qui hésite à la reprendre. Ce qui est coupé, ce sont les
        gestes, qui partiraient tous se faire refuser.
      -->
      <VerrouVeil v-if="verrou.bloque" :now-ms="room.now" />

      <template v-if="payload != null">
        <RegieHeader
          :payload="payload"
          :now-ms="room.now"
          :stream-dead="room.dead"
          :distant="true"
        />

        <main class="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-2.5">
          <ConferencePanel :payload="payload" :now-ms="room.now" />
          <!--
            L'écran de salle passe par le flux de commandes descendant, comme la
            scène : c'est ce qui permet de le piloter sans rien ajouter entre un
            téléphone et la machine de salle. Amputé de deux modes — voir le
            panneau.
          -->
          <ScreenPanel :mode="payload.state.mode" :distant="true" />
          <ProjectionPanel
            :scene-role="payload.state.sceneRole"
            :relay-source-room-id="payload.diagnostics?.relaySourceRoomId ?? null"
            :obs="null"
            :roles="rolesDistants"
          />
          <CapturePanel
            :recording="payload.diagnostics?.recording ?? null"
            :streaming="payload.state.streaming === true"
            :obs="null"
            :real-ms="clock.real"
            :room-ms="room.now"
            :distant="true"
          />
        </main>
      </template>

      <!--
        Rien encore reçu : le premier sondage n'a pas répondu. Distinct d'une
        salle vide — c'est un état d'attente, et il dure une seconde.
      -->
      <div v-else class="flex flex-1 items-center justify-center p-6 text-sm text-dim">
        Lecture de la salle…
      </div>
    </template>

    <ConferenceDialogs />
    <Toaster />
  </template>

  <template v-else>
  <PairingVeil v-if="pairingRequired && payload != null" :pairing="payload.pairing" />

  <template v-else-if="payload != null">
    <RegieHeader
      :payload="payload"
      :now-ms="room.now"
      :stream-dead="room.dead"
      @open="consult.show($event)"
      @config="config.show()"
    />

    <RoomsStrip :payload="payload" :now-ms="room.now" @open="consult.follow($event)" />

    <main
      class="grid min-h-0 gap-2.5 overflow-y-auto p-2.5 lg:grid-cols-3 lg:overflow-hidden"
    >
      <div class="flex min-h-0 flex-col gap-2.5 lg:overflow-y-auto">
        <ConferencePanel :payload="payload" :now-ms="room.now" />
        <DiagnosticsPanel :payload="payload" />
      </div>

      <div class="flex min-h-0 flex-col gap-2.5 lg:overflow-y-auto">
        <ScreenPanel :mode="payload.state.mode" />
        <ProjectionPanel
          :scene-role="payload.state.sceneRole"
          :relay-source-room-id="payload.diagnostics?.relaySourceRoomId ?? null"
          :obs="payload.diagnostics?.obs.A ?? null"
        />
        <MessagePanel />
      </div>

      <div class="flex min-h-0 flex-col gap-2.5 lg:overflow-y-auto">
        <CapturePanel
          ref="capture"
          :recording="payload.diagnostics?.recording ?? null"
          :streaming="payload.state.streaming === true"
          :obs="payload.diagnostics?.obs.B ?? null"
          :real-ms="clock.real"
          :room-ms="room.now"
          @vod="vod.show()"
        />
        <LevelMeters />
      </div>
    </main>

    <ConsultDialog :payload="payload" :now-ms="room.now" />
    <ConfigDialog :payload="payload" />
    <VodDialog :time-zone="payload.timezone" />
    <NotificationStack :payload="payload" :now-ms="room.now" />
  </template>

  <!--
    Aucun état reçu : c'est le cas du développement, où `vite dev` sert la
    coquille sans rien dedans. En salle, le poste embarque l'état dans la page
    et cet écran n'apparaît jamais.
  -->
  <div v-else class="flex flex-1 items-center justify-center p-6 text-sm text-dim">
    Connexion au poste de salle…
  </div>

  <ConferenceDialogs />
  <Toaster />
  </template>
</template>
