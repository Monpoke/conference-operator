<script setup lang="ts">
import { Toaster } from '@cloudnord/components'
import { computed, onBeforeUnmount, onMounted, useTemplateRef, watch, watchEffect } from 'vue'
import CapturePanel from './components/CapturePanel.vue'
import TalkDialogs from './components/TalkDialogs.vue'
import TalkPanel from './components/TalkPanel.vue'
import ConfigDialog from './components/ConfigDialog.vue'
import ConsultDialog from './components/ConsultDialog.vue'
import DiagnosticsPanel from './components/DiagnosticsPanel.vue'
import LevelMeters from './components/LevelMeters.vue'
import MessagePanel from './components/MessagePanel.vue'
import NotificationStack from './components/NotificationStack.vue'
import PairingVeil from './components/PairingVeil.vue'
import ProjectionPanel from './components/ProjectionPanel.vue'
import ControlHeader from './components/ControlHeader.vue'
import RoomsStrip from './components/RoomsStrip.vue'
import RoomSelect from './components/RoomSelect.vue'
import ScreenPanel from './components/ScreenPanel.vue'
import SignInScreen from './components/SignInScreen.vue'
import LockBanner from './components/LockBanner.vue'
import LockVeil from './components/LockVeil.vue'
import VodDialog from './components/VodDialog.vue'
import { useActionsStore } from './stores/actions.js'
import { useAudioStore } from './stores/audio.js'
import { useClockStore } from './stores/clock.js'
import { useConfigStore } from './stores/config.js'
import { useConsultStore } from './stores/consult.js'
import { useHostStore } from './stores/host.js'
import { useKeyboardLayer } from './stores/keyboard.js'
import { useGatewayStore } from './stores/gateway.js'
import { useProgramsStore } from './stores/programs.js'
import { useRoomStore } from './stores/room.js'
import { useSessionStore } from './stores/session.js'
import { useLockStore } from './stores/lock.js'
import { useVodStore } from './stores/vod.js'

/**
 * The control app, served from two places.
 *
 * **Local** — the room machine: three columns that do not scroll, everything
 * visible, nothing to hunt for. That is the intended layout, and below 1024 px it
 * falls back on a single scrolling column for want of anything better.
 *
 * **Remote** — the hub, on a phone: one column, and only the panels the hub has
 * the material for. Not a reduced version of the first obtained by hiding things,
 * but a layout of its own: a machine's window and a thumb's screen are not
 * arranged the same way, and pretending otherwise gives a page that is right
 * nowhere.
 *
 * What is **not** offered remotely: the markers, the VOD, the ⚙, the VU meters,
 * the diagnostics. These are machine gestures, or gestures the hub has no material
 * for — mounting them empty would be worse than not mounting them.
 */
const room = useRoomStore()
const gateway = useGatewayStore()
const session = useSessionStore()
const lock = useLockStore()
const clock = useClockStore()
const host = useHostStore()
const audio = useAudioStore()
const actions = useActionsStore()
const consult = useConsultStore()
const config = useConfigStore()
const programs = useProgramsStore()
const vod = useVodStore()

const capture = useTemplateRef<InstanceType<typeof CapturePanel>>('capture')

/** Listeners laid down only remotely; returned so they can be removed. */
let removeHistory: (() => void) | null = null
let removeLeave: (() => void) | null = null

onMounted(() => {
  clock.start()
  room.connect()
  /*
   * The VU meter and the host load only exist locally.
   *
   * Both are served by the room machine, on its own origin: opening them from a
   * phone would make two requests that fail in a loop against the hub, for panels
   * the mobile layout does not mount.
   */
  if (!gateway.remote) {
    audio.connect()
    host.start()
    return
  }
  removeHistory = gateway.followHistory()
  removeLeave = lock.releaseOnLeave()
})

onBeforeUnmount(() => {
  removeHistory?.()
  removeLeave?.()
  host.stop()
  audio.disconnect()
  room.disconnect()
  clock.stop()
})

const payload = computed(() => room.payload)

/**
 * The title follows the event, not the shell.
 *
 * The shell sets one at render time, which avoids the flash — but it is frozen at
 * that instant. The same machine will serve next year's edition, the name can
 * change on a sync mid-day, and the window bar is the first place a stale name
 * gets noticed. An operator lining up three room windows has only that to tell
 * them apart.
 */
watchEffect(() => {
  const name = payload.value?.eventIdentity?.name
  if (name == null || name === '') return
  /*
   * Remotely, the room comes before the event.
   *
   * An operator lining up three tabs on three rooms has only the title to tell
   * them apart, and the event is the same for all three.
   */
  document.title = gateway.remote
    ? `${payload.value?.roomName ?? 'Régie'} — ${name}`
    : `Régie — ${name}`
})

/*
 * The neighbouring rooms' programs follow the fingerprint, not the stream.
 *
 * The control app receives a state every few seconds; re-reading a dozen programs
 * each time would cost as many requests for an identical answer. The store only
 * reloads if the fingerprint has changed — the effect re-fires on every payload,
 * and it is `load` that stops straight away.
 */
watchEffect(() => {
  const state = payload.value?.state
  // Served by the room machine: out of a phone's reach, and the panel that reads
  // them is not mounted remotely.
  if (state != null && !gateway.remote) void programs.load(state.contentHash, state.roomId)
})

/**
 * The scene roles the room has actually mapped.
 *
 * Served by the hub and not deduced from a constant: a room with no `RELAY`
 * configured does not show the button, exactly as in the room's own control app.
 * Locally the panel keeps its own rule — the configuration is at hand.
 */
const remoteRoles = computed(() =>
  Object.keys(payload.value?.diagnostics?.config?.sceneRoles.A ?? {}),
)

/**
 * An unpaired machine has nothing to drive.
 *
 * The veil is not laid "over" the page: it replaces it. `paired` is the only value
 * that lifts it, and so is the absence of a `pairing` block — a room already
 * linked receives none.
 */
const pairingRequired = computed(
  () => payload.value?.pairing != null && payload.value.pairing.status !== 'paired',
)

/**
 * The configuration comes to the front if the room is not ready.
 *
 * At the machine's start-up and **once it is paired**: before that there is no
 * room and no configuration, and the veil takes the screen anyway. That is the
 * first moment the panel has something to show.
 *
 * The store holds the rest: the verdict, taken without waiting, and the fact that
 * this happens only once per page load.
 *
 * Nothing remotely: the configuration panel is not mounted there, and a phone is
 * not where one plugs in an OBS.
 */
watch(
  [() => gateway.remote, pairingRequired, payload],
  ([remote, needsPairing, received]) => {
    if (remote || needsPairing || received == null) return
    config.checkAtStartup()
  },
  { immediate: true },
)

/**
 * The page's shortcuts, on the bottom layer.
 *
 * In a dark room, aiming at a button costs more than pressing a key. Any modal
 * will lay a layer over this one and swallow them: that is what stops a reflex "r"
 * starting a take underneath an open question.
 */
useKeyboardLayer(
  () => ({
    l: () => void actions.act({ action: 'scene.set', role: 'LIVE' }),
    h: () => void actions.act({ action: 'scene.set', role: 'HOLD' }),
    r: () => capture.value?.toggleRecording(),
    m: () => capture.value?.mark(),
    /*
     * The two editing anchors have their key, like the take.
     *
     * These are gestures made while watching the room, not the screen: the speaker
     * starts, the speaker finishes. Going through the label field to type "Début"
     * would miss the very instant one wanted to mark — and here the instant is all
     * the information there is.
     */
    d: () => capture.value?.anchor('debut'),
    f: () => capture.value?.anchor('fin'),
    s: () => consult.show('rooms'),
    p: () => consult.show('program'),
  }),
  /*
   * Nothing under the pairing veil, and nothing on a phone.
   *
   * The original page kept its shortcuts alive behind the veil — its listener was
   * global and the veil was only an attribute on the `<body>`. Typing "l" on an
   * unpaired machine posted a scene switch towards an OBS it does not have, and
   * collected a red failure for an answer.
   *
   * Remotely, `m`, `d`, `f`, `s` and `p` aim at panels that are absent — and a soft
   * keyboard opening on a search field would fire the rest.
   */
  () => !pairingRequired.value && !gateway.remote,
)
</script>

<template>
  <!--
    Remotely, three screens before the control app, in this order: sign in, choose
    a room, drive it. Each replaces the previous one — a desk held in one hand has
    no room for two things at once.
  -->
  <template v-if="gateway.remote">
    <SignInScreen v-if="!session.signedIn" />
    <RoomSelect v-else-if="gateway.roomChoice" />

    <template v-else>
      <LockBanner :now-ms="room.now" />

      <!--
        The lock veil over the top, and not in its place.

        The room's state stays readable underneath: coming to look at a room a
        colleague is driving is a normal use — it is even what somebody hesitating
        to take it over does. What is cut off are the gestures, which would all
        leave only to be refused.
      -->
      <LockVeil v-if="lock.blocked" :now-ms="room.now" />

      <template v-if="payload != null">
        <ControlHeader
          :payload="payload"
          :now-ms="room.now"
          :stream-dead="room.dead"
          :remote="true"
        />

        <main class="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-2.5">
          <TalkPanel :payload="payload" :now-ms="room.now" />
          <!--
            The room screen goes through the downstream command flow, like the
            scene: that is what lets it be driven with nothing added between a phone
            and the room machine. Short of two modes — see the panel.
          -->
          <ScreenPanel :mode="payload.state.mode" :remote="true" />
          <ProjectionPanel
            :scene-role="payload.state.sceneRole"
            :relay-source-room-id="payload.diagnostics?.relaySourceRoomId ?? null"
            :obs="null"
            :roles="remoteRoles"
          />
          <CapturePanel
            :recording="payload.diagnostics?.recording ?? null"
            :streaming="payload.state.streaming === true"
            :obs="null"
            :real-ms="clock.real"
            :room-ms="room.now"
            :remote="true"
          />
        </main>
      </template>

      <!--
        Nothing received yet: the first poll has not answered. Distinct from an
        empty room — it is a waiting state, and it lasts a second.
      -->
      <div v-else class="flex flex-1 items-center justify-center p-6 text-sm text-dim">
        Lecture de la salle…
      </div>
    </template>

    <TalkDialogs />
    <Toaster />
  </template>

  <template v-else>
  <PairingVeil v-if="pairingRequired && payload != null" :pairing="payload.pairing" />

  <template v-else-if="payload != null">
    <ControlHeader
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
        <TalkPanel :payload="payload" :now-ms="room.now" />
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
    No state received: the development case, where `vite dev` serves the shell with
    nothing inside. In a room the machine embeds the state in the page and this
    screen never appears.
  -->
  <div v-else class="flex flex-1 items-center justify-center p-6 text-sm text-dim">
    Connexion au poste de salle…
  </div>

  <TalkDialogs />
  <Toaster />
  </template>
</template>
