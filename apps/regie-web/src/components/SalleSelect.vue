<script setup lang="ts">
import type { ControlRoom } from '@cloudnord/contract'
import { Button, Panel, StatusDot } from '@cloudnord/components'
import { appearanceOf } from '@cloudnord/room-state'
import { timeAgo } from '@cloudnord/format'
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { usePorteStore } from '../stores/porte.js'
import { useSessionStore } from '../stores/session.js'
import { useVerrouStore } from '../stores/verrou.js'

/**
 * Choisir une salle, et savoir si elle est libre.
 *
 * Des cartes et non un tableau : la régie mobile se tient debout, au fond d'une
 * salle ou dans un couloir, et six colonnes y deviennent illisibles. C'est le
 * même raisonnement que l'onglet Exploitation de la console, dans un format qui
 * n'a jamais que la largeur d'un pouce.
 *
 * Chaque carte porte les deux choses qui décident : **où en est la salle** — le
 * mot, pas seulement la teinte — et **qui la tient**, s'il y a quelqu'un.
 */
const porte = usePorteStore()
const session = useSessionStore()
const verrou = useVerrouStore()

/** Rafraîchi au même rythme que la supervision de la console : rien ne se pilote ici. */
const RAFRAICHISSEMENT_MS = 10_000
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  void verrou.charger()
  timer = setInterval(() => void verrou.charger(), RAFRAICHISSEMENT_MS)
})

onBeforeUnmount(() => {
  if (timer != null) clearInterval(timer)
})

/**
 * Les salles de l'amorce en attendant celles du hub.
 *
 * Les noms sont posés dans la coquille, donc affichables avant toute réponse :
 * une liste vide le temps d'un aller-retour se lit comme un hub sans
 * programme. Elles n'ont ni état ni verrou tant que le premier appel n'a pas
 * répondu, et les cartes le disent en restant neutres plutôt qu'en affirmant
 * « hors créneau ».
 */
const salles = computed<ControlRoom[]>(() =>
  verrou.salles.length > 0
    ? verrou.salles
    : porte.amorce.salles.map((salle) => ({
        roomId: salle.id,
        name: salle.name,
        conference: 'aucune' as const,
        connectivity: 'OFFLINE' as const,
        lock: null,
      })),
)

const maintenant = ref(Date.now())
let horloge: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  horloge = setInterval(() => (maintenant.value = Date.now()), 1_000)
})
onBeforeUnmount(() => {
  if (horloge != null) clearInterval(horloge)
})

/** Le porteur, ou `null` : c'est ce mot-là qui décide s'il faut reprendre. */
function tenuePar(salle: ControlRoom): string | null {
  return salle.lock?.holder ?? null
}

/**
 * Tenue par **mon compte**, ce qui ne veut pas dire par cet onglet-ci.
 *
 * La liste ne peut pas trancher plus finement : elle sert à choisir où aller,
 * et le voile de la salle dira ensuite s'il s'agit de cet onglet ou d'un autre
 * de vos appareils. Écrire « vous la tenez » ici mentirait la moitié du temps.
 */
function moi(salle: ControlRoom): boolean {
  return tenuePar(salle) != null && tenuePar(salle) === session.identity
}

/**
 * Entrer, sans prendre.
 *
 * Une seule décision, au même endroit : le voile de la salle. Prendre depuis
 * cette liste obligeait à trancher sur la foi d'une ligne — « nuit@… tient
 * Track #1 » — sans voir ce qui s'y joue, alors que c'est précisément ce qu'on
 * veut regarder avant de retirer ses commandes à quelqu'un.
 *
 * Le prix est un aller-retour de plus pour la salle libre, la plus fréquente.
 * Il est faible : le voile s'ouvre déjà rempli, et son bouton est le premier
 * sous le pouce.
 */
function ouvrir(salle: ControlRoom): void {
  verrou.regarder(salle.roomId)
}
</script>

<template>
  <main class="mx-auto w-full max-w-[560px] p-3">
    <h1 class="mb-1 text-base font-semibold">Régie mobile</h1>
    <p class="mb-3 text-xs text-dim">
      Choisissez une salle. Une seule régie mobile la pilote à la fois — celle de
      la salle, elle, garde toujours la main.
    </p>

    <div class="flex flex-col gap-2">
      <Panel v-for="salle in salles" :key="salle.roomId">
        <button
          class="flex w-full items-start gap-2.5 text-left"
          :data-salle="salle.roomId"
          @click="ouvrir(salle)"
        >
          <StatusDot
            class="mt-1 shrink-0"
            :state="salle.conference"
            :connectivity="salle.connectivity"
          />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm">{{ salle.name }}</span>
            <span class="block text-xs" :class="appearanceOf(salle.conference).text">
              {{ appearanceOf(salle.conference).word }}
            </span>
            <!--
              Le porteur, nommé, avec depuis quand. « Occupée » seul ferait
              chercher qui : la réponse est à deux salles de là, et c'est
              l'aller-retour qu'on évite.
            -->
            <span v-if="tenuePar(salle) != null" class="mt-0.5 block text-xs text-warn">
              <template v-if="moi(salle)">
                Tenue par votre compte · depuis {{ timeAgo(salle.lock!.heldSince, maintenant) }}
              </template>
              <template v-else>
                {{ tenuePar(salle) }} · depuis
                {{ timeAgo(salle.lock!.heldSince, maintenant) }}
              </template>
            </span>
          </span>
          <span class="shrink-0 self-center text-xs text-dim" aria-hidden="true">›</span>
        </button>
      </Panel>
    </div>

    <div class="mt-4 flex items-center justify-between text-xs text-dim">
      <span>{{ session.identity ?? 'Connecté' }}</span>
      <Button @click="session.signOut()">Se déconnecter</Button>
    </div>

  </main>
</template>
