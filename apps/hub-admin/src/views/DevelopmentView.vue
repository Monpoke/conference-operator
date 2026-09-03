<script setup lang="ts">
import { Button, ConfirmDialog, Hint, Panel, useToast } from '@cloudnord/components'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import {
  activeSessions,
  forInput,
  programMoments,
  useDevStore,
} from '../stores/dev.js'
import { useConferencesStore } from '../stores/conferences.js'

/**
 * Les commodités de développement.
 *
 * Elles n'ont rien à faire devant une salle, et trois verrous le garantissent —
 * chacun couvrant ce que les autres laissent passer : cette vue n'est pas
 * servie hors mode dev, son module n'entre pas dans le bundle de production
 * (le routeur l'importe à la demande), et le hub refuse `clock/set` comme
 * `vod/reset` de son côté.
 */
const store = useDevStore()
const { clock } = storeToRefs(store)
const toast = useToast()

const cible = ref('')
const razOuverte = ref(false)
const razMot = ref('')
const razCible = ref({ cible: '', salles: 0 })

const fuseau = computed(() => useConferencesStore().planning?.timezone)

/**
 * L'heure du hub, lue dans le fuseau de l'événement.
 *
 * Comme partout ailleurs dans la console : la lire dans celui du poste d'où
 * l'on regarde est justement l'erreur que ce réglage sert à débusquer.
 */
const lisible = computed(() =>
  clock.value == null
    ? '—'
    : new Intl.DateTimeFormat('fr-FR', {
        dateStyle: 'full',
        timeStyle: 'medium',
        timeZone: fuseau.value,
      }).format(new Date(clock.value.serverTime)),
)

const raccourcis = computed(() => programMoments(activeSessions()))

async function appliquer(): Promise<void> {
  if (cible.value === '') return
  try {
    await store.setClock(new Date(cible.value).toISOString())
    toast.say('Heure du hub modifiée')
  } catch {
    /* déjà remonté */
  }
}

async function revenir(): Promise<void> {
  try {
    await store.setClock(null)
    toast.say("Retour à l'heure réelle")
  } catch {
    /* déjà remonté */
  }
}

async function ouvrirRaz(): Promise<void> {
  razMot.value = ''
  razCible.value = await store.resetTarget()
  razOuverte.value = true
}

async function confirmerRaz(): Promise<void> {
  try {
    const bilan = await store.reset()
    razOuverte.value = false
    toast.say(
      `${bilan.objets} objet(s) supprimé(s), ${bilan.multiparts} téléversement(s) abandonné(s), ` +
        `${bilan.salles} salle(s) prévenue(s).`,
    )
  } catch {
    /* déjà remonté */
  }
}
</script>

<template>
  <div
    id="vue-developpement"
    class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] items-start gap-3.5"
  >
    <Panel title="Heure du hub">
      <div class="flex items-center gap-3 border-b border-edge pb-3">
        <div class="flex-1">
          <strong
            id="horloge-etat"
            class="mb-[3px] block text-sm"
            :class="clock?.simulated === true ? 'text-warn' : ''"
          >
            {{ clock?.simulated === true ? 'Horloge SIMULÉE' : 'Heure réelle' }}
          </strong>
          <span id="horloge-valeur" class="text-xs text-dim">{{ lisible }}</span>
        </div>
      </div>

      <div v-if="clock?.controllable === true" id="horloge-controles" class="mt-3">
        <label class="mb-[5px] block text-xs text-dim" for="horloge-cible">Se placer à</label>
        <input
          id="horloge-cible"
          v-model="cible"
          type="datetime-local"
          step="60"
          class="mb-[11px] w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text"
        />
        <div class="flex gap-1.5">
          <Button id="btn-horloge-appliquer" variant="primary" size="small" @click="appliquer">
            Appliquer
          </Button>
          <Button id="btn-horloge-reelle" size="small" @click="revenir">
            Revenir à l'heure réelle
          </Button>
        </div>
        <div id="horloge-raccourcis" class="mt-2 flex flex-wrap gap-1.5">
          <Button
            v-for="[libelle, iso] in raccourcis"
            :key="iso"
            size="small"
            @click="cible = forInput(iso)"
          >
            {{ libelle }}
          </Button>
        </div>
      </div>

      <Hint id="horloge-aide">
        <template v-if="clock?.controllable === true">
          Déplacer l'heure déplace <strong>tout le système</strong> : les salles s'alignent
          aussitôt. Outil de développement — pendant l'événement, cela fausserait les timecodes
          des enregistrements et déclencherait des clôtures à contretemps.
        </template>
        <template v-else>
          Réglage fermé : ce hub tourne en production. Il s'ouvre avec <code>MODE=dev</code>, à
          réserver au développement.
        </template>
      </Hint>
    </Panel>

    <!--
      Remise à zéro des données.

      Le seul geste du système dont on ne revient pas. Il vit ici, avec
      l'horloge, parce que les deux ont la même nature : des commodités de
      développement qui n'ont rien à faire devant une salle.
    -->
    <Panel title="Remise à zéro des données">
      <Hint class="mt-0">
        Efface <strong>tout ce qui est sous le préfixe</strong> du bucket — téléversements en
        cours compris — et demande à chaque salle d'effacer ses rushes, leurs sidecars et ses
        verdicts de relecture. Le programme, les salles et les comptes ne sont pas touchés.
      </Hint>
      <Hint>
        Un préfixe est <strong>exigé</strong> : sans lui, « le préfixe » et « le bucket entier »
        sont la même chose. Côté salle, seuls les fichiers que l'application connaît partent — la
        racine des captations est parfois un disque partagé.
      </Hint>
      <Button id="btn-raz" class="mt-3 w-full" @click="ouvrirRaz">Remettre à zéro…</Button>
    </Panel>

    <Panel title="Ce menu n'existe qu'en mode dev">
      <Hint class="mt-0">
        Le hub tourne avec <strong>MODE=dev</strong>. En production, ce menu n'est pas rendu du
        tout, son code n'entre pas dans le bundle, et <code>clock/set</code> est refusé côté
        serveur : trois verrous, parce qu'un seul se contourne.
      </Hint>
    </Panel>

    <ConfirmDialog
      v-model:open="razOuverte"
      title="Tout remettre à zéro ?"
      confirm-label="Remettre à zéro"
      danger
      :confirm-disabled="razMot.trim() !== 'RAZ'"
      @confirm="confirmerRaz"
    >
      <p id="raz-text">
        Tout ce qui est sous <strong>{{ razCible.cible }}</strong> sera supprimé, et
        <strong>{{ razCible.salles }} salle{{ razCible.salles > 1 ? 's' : '' }}</strong>
        effaceront leurs rushes.
      </p>
      <p class="mt-3 text-[13px] leading-relaxed text-dim">
        <strong>Irréversible.</strong> Les objets du préfixe sont supprimés chez le stockage,
        chaque salle efface ses rushes, leurs sidecars et ses verdicts de relecture, et le hub
        oublie ce qu'il savait des prises — sans quoi le dossier VOD des conférences continuerait
        de lister des captations dont plus aucun fichier n'existe. Rien de tout cela ne se
        rattrape.
      </p>
      <div class="mt-3">
        <label class="mb-[5px] block text-xs text-dim" for="raz-mot">
          Recopier <strong>RAZ</strong> pour confirmer
        </label>
        <!--
          Le bouton ne s'arme qu'au mot exact : c'est ce qui distingue « avoir
          lu » de « avoir cliqué ».
        -->
        <input
          id="raz-mot"
          v-model="razMot"
          type="text"
          autocomplete="off"
          placeholder="RAZ"
          class="w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text"
        />
      </div>
    </ConfirmDialog>
  </div>
</template>
