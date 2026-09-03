<script setup lang="ts">
import type { DisplayPayload } from '@cloudnord/contract'
import { Button, Dialog, Panel } from '@cloudnord/components'
import { computed } from 'vue'
import { ROLES, useConfigStore } from '../stores/config.js'
import { useKeyboardLayer } from '../stores/keyboard.js'
import ObsConfigBlock from './ObsConfigBlock.vue'

const props = defineProps<{ payload: DisplayPayload }>()

const config = useConfigStore()

// Une couche vide : on tape des adresses et des mots de passe ici, et un « r »
// hors champ ne doit pas lancer une captation derrière la modale.
useKeyboardLayer(() => ({}), () => config.open)

/** Les autres salles, pour le relais. Une salle ne se relaie pas elle-même. */
const others = computed(() =>
  (props.payload.diagnostics?.rooms ?? []).filter(
    (room) => room.roomId !== props.payload.state.roomId,
  ),
)

const noticeTone = computed(() => {
  // Hors ligne passe devant : c'est la raison pour laquelle le bouton est
  // désarmé, et elle prime sur le résultat du dernier enregistrement.
  if (!config.online) return 'text-warn'
  if (config.notice?.tone === 'ok') return 'text-ok'
  return config.notice?.tone === 'alert' ? 'text-alert' : 'text-dim'
})

const FIELD =
  'w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text focus:border-brand focus:outline-none'
</script>

<template>
  <Dialog v-model:open="config.open" title="Configuration de la salle" width="full">
    <!--
      Rien à configurer sans le hub : c'est lui qui détient la configuration de
      la salle. Un formulaire vide se remplirait de zéros et les enverrait.
    -->
    <p v-if="config.draft == null || config.config == null" class="text-sm text-dim">
      Rien à configurer tant que le hub n'a pas répondu : c'est lui qui détient la configuration
      de la salle.
    </p>

    <template v-else>
      <!--
        Ce qui manque, avant les champs qui le corrigent.

        Affiché quel que soit celui qui a ouvert le panneau : l'opérateur venu
        changer un port profite de la même liste. La phrase de tête change,
        elle, parce qu'un panneau qui s'ouvre tout seul se lit comme une fausse
        manœuvre tant qu'il n'a pas dit pourquoi il est là.
      -->
      <div
        v-if="config.manques.length > 0"
        class="mb-2.5 rounded-lg border border-warn/40 px-2.5 py-2 text-[11px] text-warn"
        data-role="config-manques"
      >
        <p class="font-semibold">
          {{
            config.openAtStartup
              ? 'Cette salle n’est pas prête : ouvert au démarrage pour ces raisons.'
              : 'Cette salle n’est pas prête.'
          }}
        </p>
        <ul class="mt-1 list-disc pl-4">
          <li v-for="manque in config.manques" :key="manque.code" :data-manque="manque.code">
            {{ manque.texte }}
          </li>
        </ul>
      </div>

      <ObsConfigBlock
        instance="A"
        title="OBS-A — projection"
        :draft="config.draft"
        :config="config.config"
        :obs="payload.diagnostics?.obs.A ?? null"
        @connect="config.connect('A')"
      />
      <ObsConfigBlock
        instance="B"
        title="OBS-B — captation"
        :draft="config.draft"
        :config="config.config"
        :obs="payload.diagnostics?.obs.B ?? null"
        @connect="config.connect('B')"
      />

      <Panel title="Salle">
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="mb-0.5 block text-xs text-dim" for="cfg-port">
              Port de l'écran local
            </label>
            <input id="cfg-port" v-model="config.draft.displayPort" :class="FIELD" />
            <p class="mt-0.5 text-[11px] text-dim">
              Prend effet au prochain démarrage du client.
            </p>
          </div>
          <div>
            <label class="mb-0.5 block text-xs text-dim" for="cfg-slug">
              Préfixe des fichiers
            </label>
            <input id="cfg-slug" v-model="config.draft.fileSlug" :class="FIELD" />
            <p class="mt-0.5 text-[11px] text-dim">
              Utilisé dans les noms d'enregistrements. Vide : dérivé du nom de la salle.
            </p>
          </div>
          <div>
            <label class="mb-0.5 block text-xs text-dim" for="cfg-root">Dossier des VOD</label>
            <div class="flex gap-1.5">
              <input id="cfg-root" v-model="config.draft.recordingRoot" :class="FIELD" />
              <!--
                Le sélecteur parcourt le disque **du poste**, où qu'on lise cette
                page : c'est là que les rushes s'écrivent, et ce champ n'a jamais
                désigné autre chose. D'où le mot « poste » sur le bouton.
              -->
              <Button
                v-if="config.canBrowse"
                id="btn-parcourir-vod"
                class="shrink-0"
                title="Choisir le dossier sur le poste de la salle"
                @click="config.parcourir()"
              >
                Parcourir…
              </Button>
            </div>
            <p class="mt-0.5 text-[11px] text-dim">
              Où la régie relit les enregistrements (🎞 dans le panneau Captation). Vide : le
              dossier d’OBS-B, qu’elle lui demande. Ce champ ne déplace rien : c’est OBS-B qui
              décide où il écrit.
            </p>
          </div>
          <div>
            <label class="mb-0.5 block text-xs text-dim" for="cfg-relay">Salle relayée</label>
            <select id="cfg-relay" v-model="config.draft.relaySourceRoomId" :class="FIELD">
              <option value="">— aucune —</option>
              <option v-for="room in others" :key="room.roomId" :value="room.roomId">
                {{ room.name }}
              </option>
            </select>
            <p class="mt-0.5 text-[11px] text-dim">
              Active le bouton « Relais » en projection. L'acheminement du flux reste une affaire
              de configuration OBS.
            </p>
          </div>
        </div>

        <!--
          Ce que « Commencer » entraîne.

          Deux gestes que la régie faisait de mémoire, et qu'elle oubliait aux
          moments les plus coûteux : lancer l'enregistrement, et passer à
          l'antenne. Les rattacher au démarrage de la conférence les met là où
          l'information existe — c'est le seul instant où l'on sait qu'un talk
          commence.
        -->
        <h3 class="mt-3.5 mb-2.5 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
          Au démarrage et à la fin d’une conférence
        </h3>
        <label class="flex items-start gap-2 text-sm">
          <input id="cfg-prompt-rec" v-model="config.draft.promptRecordingOnStart" type="checkbox" class="mt-0.5" />
          <span>
            Avertir si l’enregistrement n’est pas lancé
            <span class="block text-[11px] text-dim">
              Une VOD manquante ne se rattrape pas le soir.
            </span>
          </span>
        </label>
        <label class="mt-2 flex items-start gap-2 text-sm">
          <input id="cfg-prompt-rec-stop" v-model="config.draft.promptRecordingOnStop" type="checkbox" class="mt-0.5" />
          <span>
            Proposer d’arrêter l’enregistrement en terminant
            <span class="block text-[11px] text-dim">
              Sans quoi le talk suivant s’écrit dans le même fichier, sous le titre de celui-ci.
            </span>
          </span>
        </label>
        <div class="mt-2">
          <label class="mb-0.5 block text-xs text-dim" for="cfg-scene-demarrage">
            Scène prise automatiquement
          </label>
          <select id="cfg-scene-demarrage" v-model="config.draft.sceneOnStart" :class="FIELD">
            <option value="">— aucune bascule —</option>
            <option v-for="entry in ROLES.A" :key="entry.role" :value="entry.role">
              {{ entry.label }}
            </option>
          </select>
          <p class="mt-0.5 text-[11px] text-dim">
            Sans elle, l’habillage reste à l’écran pendant les premières phrases.
          </p>
        </div>
      </Panel>
    </template>

    <template #actions>
      <Button size="small" @click="config.refreshScenes()">Relire les scènes d'OBS</Button>
      <span class="flex-1 self-center text-xs" :class="noticeTone" data-role="config-avis">
        <!--
          Hors ligne, le bouton est désarmé : enregistrer serait une promesse en
          l'air, la saisie repartirait au premier sync réussi.
        -->
        {{
          config.online
            ? (config.notice?.text ?? '')
            : "Hub injoignable : la configuration s'enregistre sur le hub, elle serait perdue au prochain sync."
        }}
      </span>
      <Button
        id="btn-config-enregistrer"
        variant="primary"
        size="small"
        :disabled="!config.online || config.saving || config.draft == null"
        @click="config.save()"
      >
        Enregistrer
      </Button>
    </template>
  </Dialog>
</template>
