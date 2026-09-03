<script setup lang="ts">
import { appearanceOf } from '@cloudnord/room-state'
import { Badge, Empty, Panel, StatusDot } from '@cloudnord/components'
import { time, timeAgo } from '@cloudnord/format'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useConferencesStore } from '../stores/conferences.js'
import { slotRemaining, useOperationsStore, type RoomStatus } from '../stores/operations.js'

/**
 * Le tableau de bord.
 *
 * C'est la vue laissée ouverte toute la journée, et celle qu'on regarde de
 * loin : d'où des cartes plutôt qu'un tableau, un mot à côté de chaque couleur,
 * et rien qui demande de lire pour comprendre qu'une salle va mal.
 */
const store = useOperationsStore()
const { rooms, globalBreak } = storeToRefs(store)

/**
 * Le fuseau de l'événement, quand il est connu.
 *
 * Il vient du planning, que cette vue ne charge pas — elle n'en a besoin que
 * pour deux heures dans l'encart Global. Sans lui, l'heure du poste sert, ce
 * qui reproduit exactement ce que faisait la page. Une salle n'est pas
 * concernée : les cartes ne portent aucune heure absolue, seulement des durées.
 */
const fuseau = computed(() => useConferencesStore().planning?.timezone)

function appearance(salle: RoomStatus): { word: string; text: string } {
  const { word, text } = appearanceOf(salle.conference)
  return { word, text }
}

/**
 * Un créneau commun ne se présente pas comme une conférence.
 *
 * Pendant le déjeuner, la carte annonçait « Déjeuner · 22 min restantes »
 * exactement comme elle annonce un talk : même place, même forme, même
 * décompte. On lisait une salle occupée là où il n'y a personne. Une étiquette
 * à côté du nom, et la ligne du dessous se tait — le détail du créneau vit dans
 * l'encart Global, où il est dit une fois pour toutes.
 */
function enPause(salle: RoomStatus): boolean {
  return salle.breakBadge?.state === 'en-cours'
}

function reste(salle: RoomStatus): ReturnType<typeof slotRemaining> {
  return enPause(salle) ? null : slotRemaining(salle.currentSession?.remainingMs)
}

/** Ce qu'on vient chercher dans l'encart : quand ça reprend, ou quand ça commence. */
const detailGlobal = computed(() => {
  const pause = globalBreak.value
  if (pause == null) return ''
  const salles = `${pause.rooms} ${pause.rooms > 1 ? 'salles' : 'salle'}`
  const enCours = pause.state === 'en-cours'
  const bord = enCours ? pause.endsAt : pause.startsAt
  if (bord == null) return salles
  const minutes = Math.round((Date.parse(bord) - Date.parse(pause.serverTime)) / 60000)
  return `${enCours ? 'reprise dans ' : 'dans '}${minutes} min · ${salles}`
})
</script>

<template>
  <div
    id="vue-exploitation"
    class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] items-start gap-3.5"
  >
    <Panel v-if="globalBreak != null" id="encart-global" class="col-span-full" title="Global">
      <div class="flex items-center gap-2">
        <!--
          Le créneau commun n'est pas une conférence : sa teinte est posée à la
          main, et ne vient pas de la table des apparences — `APPEARANCE.pause`
          décrit une *salle* en pause, pas le créneau lui-même.
        -->
        <span
          id="global-pastille"
          class="pastille"
          :class="globalBreak.state === 'en-cours' ? 'pause' : 'pas-commencee'"
        ></span>
        <span id="global-titre" class="flex-1 truncate font-semibold">
          {{ globalBreak.title }}{{ globalBreak.state === 'en-cours' ? '' : ' — à venir' }}
        </span>
        <span id="global-horaire" class="shrink-0 text-[13px] text-attenue tabular-nums">
          {{ time(globalBreak.startsAt, fuseau)
          }}{{ globalBreak.endsAt ? ` – ${time(globalBreak.endsAt, fuseau)}` : '' }}
        </span>
      </div>
      <div id="global-detail" class="mt-1 text-xs text-attenue">{{ detailGlobal }}</div>
    </Panel>

    <Panel class="col-span-full" title="Salles">
      <div
        id="salles"
        class="grid grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-2.5"
      >
        <Empty v-if="rooms.length === 0">Aucune salle déclarée.</Empty>

        <div
          v-for="salle in rooms"
          :key="salle.roomId"
          class="rounded-xl border border-bord bg-fond p-3"
          :data-salle="salle.roomId"
        >
          <div class="flex items-center gap-2">
            <StatusDot :state="salle.conference" :connectivity="salle.connectivity" />
            <span class="min-w-0 flex-1 truncate font-semibold">{{ salle.name }}</span>
            <Badge
              v-if="salle.breakBadge != null"
              class="px-1.5 py-0.5 text-[11px] tracking-normal"
              :variant="enPause(salle) ? 'neutral' : 'warning'"
            >
              {{ enPause(salle) ? 'BREAK' : 'BREAK à venir' }}
            </Badge>
            <a
              class="shrink-0 text-[13px] text-marque no-underline"
              target="_blank"
              rel="noopener"
              :href="`/mur?salle=${encodeURIComponent(salle.roomId)}`"
            >
              mur ↗
            </a>
          </div>

          <!-- Ce qui se joue : la première chose qu'on vient vérifier. -->
          <div class="mt-1.5 text-[13px] leading-snug">
            <span v-if="enPause(salle)" class="text-attenue">—</span>
            <template v-else-if="salle.currentSession != null">
              {{ salle.currentSession.title }}
            </template>
            <span v-else class="text-attenue">Rien au programme</span>
          </div>

          <!--
            Et pour combien de temps encore : sans ça, savoir ce qui se joue ne
            dit pas si la salle est en avance, à l'heure, ou en train de déborder.
          -->
          <div
            v-if="reste(salle) != null"
            class="mt-0.5 text-xs"
            :class="reste(salle)!.depasse ? 'text-alerte' : 'text-attenue'"
          >
            {{ reste(salle)!.texte }}
          </div>

          <div
            v-if="salle.recording || salle.streaming || salle.sceneRole != null || salle.outboxDepth > 0"
            class="mt-2 flex flex-wrap gap-1.5"
          >
            <Badge v-if="salle.recording" class="px-1.5 py-0.5 text-[11px] tracking-normal" variant="alert">
              ● REC
            </Badge>
            <Badge v-if="salle.streaming" class="px-1.5 py-0.5 text-[11px] tracking-normal text-ok">
              ● LIVE
            </Badge>
            <Badge v-if="salle.sceneRole != null" class="px-1.5 py-0.5 text-[11px] tracking-normal">
              {{ salle.sceneRole }}
            </Badge>
            <Badge
              v-if="salle.outboxDepth > 0"
              class="px-1.5 py-0.5 text-[11px] tracking-normal"
              variant="warning"
            >
              {{ salle.outboxDepth }} en file
            </Badge>
          </div>

          <!--
            Le mot accompagne la couleur : une pastille seule ne se lit pas
            quand on ne distingue pas les teintes, et la carte se regarde de loin.
          -->
          <div class="mt-2 text-xs text-attenue">
            <span :class="appearance(salle).text">
              {{ salle.connectivity === 'ONLINE' ? appearance(salle).word : 'salle muette' }}
            </span>
            · {{ salle.connectivity.toLowerCase() }} · vu {{ timeAgo(salle.lastSeenAt) }}
          </div>
        </div>
      </div>
    </Panel>
  </div>
</template>
