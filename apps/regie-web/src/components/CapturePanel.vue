<script setup lang="ts">
import type { ControlDiagnostics, MarkerRole, ObsState } from '@cloudnord/contract'
import { NO_EDITING_MARKS } from '@cloudnord/contract'
import { Button, Key, Panel } from '@cloudnord/components'
import { shortDuration } from '@cloudnord/format'
import { computed, ref } from 'vue'
import { useActionsStore } from '../stores/actions.js'
import RecordingTimer from './RecordingTimer.vue'
import SimulatedBadge from './SimulatedBadge.vue'

const props = defineProps<{
  recording: ControlDiagnostics['recording'] | null
  streaming: boolean
  obs: ObsState | null
  realMs: number
  roomMs: number
  /**
   * Servi par le hub, pas par la machine de salle.
   *
   * Trois choses tombent alors, et chacune pour sa raison. **Le chronomètre** :
   * le hub ne stocke qu'un booléen, et afficher une durée fausse à côté d'un
   * point rouge juste est pire que de ne rien afficher. **Le marqueur** et
   * **les rushes** : ils demandent le disque de la salle, qu'aucun téléphone
   * n'atteint.
   */
  distant?: boolean
}>()

const emit = defineEmits<{ vod: [] }>()

const actions = useActionsStore()
const label = ref('')

const active = computed(() => props.recording?.active === true)

function toggleRecording(): void {
  void actions.act({ action: active.value ? 'recording.stop' : 'recording.start' })
}

function toggleStream(): void {
  void actions.act({ action: props.streaming ? 'stream.stop' : 'stream.start' })
}

function mark(): void {
  /*
   * Le refus est ici, et pas seulement sur l'attribut du bouton.
   *
   * Le raccourci `m` atteint cette fonction sans passer par le bouton : la page
   * d'origine héritait du garde-fou parce qu'elle cliquait dessus, et qu'un
   * bouton désactivé ignore le clic. Appelée directement, elle postait une
   * commande que le poste refuse — un échec clignotant pour un geste que la
   * page savait impossible.
   */
  if (!active.value) return
  // Un marqueur sans libellé reste un marqueur : au editing, savoir *où* vaut
  // déjà mieux que rien, et exiger un mot ferait rater l'instant.
  void actions.act({ action: 'recording.mark', label: label.value.trim() || 'Chapitre' })
  label.value = ''
}

const markers = computed(() => {
  if (!active.value) return 'hors enregistrement'
  const count = props.recording?.markers ?? 0
  return count === 0 ? 'aucun marqueur' : `${count} marqueur(s)`
})

const editing = computed(() => props.recording?.editing ?? NO_EDITING_MARKS)

/**
 * Ce que porte un bouton de repère : son nom, et où il est tombé.
 *
 * Le décalage plutôt qu'un simple bouton allumé. Les deux disent « c'est
 * posé », mais un seul répond à la question suivante — « posé *où* ? » —, et
 * c'est celle qu'on se pose quand on hésite à le reposer.
 */
function repereLabel(nom: string, ms: number | null): string {
  return ms == null ? nom : `${nom} · ${shortDuration(ms)}`
}

/**
 * Pose l'un des deux repères de editing.
 *
 * Le libellé est écrit ici et pas saisi : c'est ce qui se relit dans le journal
 * du hub, et il doit dire la même chose d'une salle à l'autre. Le poste, lui,
 * ne lit que `role`.
 */
function repere(role: MarkerRole): void {
  // Même garde-fou que `mark()`, et pour la même raison : `d` et `f` atteignent
  // cette fonction sans passer par le bouton, qu'un attribut désactive en vain.
  if (!active.value) return
  void actions.act({ action: 'recording.mark', label: role === 'debut' ? 'Début' : 'Fin', role })
}

defineExpose({ toggleRecording, mark, repere })
</script>

<template>
  <Panel>
    <div class="mb-1.5 flex items-center gap-2">
      <h2 class="flex-1 text-[11px] font-semibold tracking-[.14em] text-attenue uppercase">
        Captation — OBS&nbsp;B<SimulatedBadge :when="obs?.simulated === true" />
      </h2>
      <!--
        Vérifier les rushes se fait pendant l'événement ou jamais : la salle est
        démontée bien avant que quiconque ouvre les fichiers. Discret pour
        autant — ce n'est pas une commande de la conférence en cours, et rien ne
        doit le faire confondre avec « Enregistrer ».
      -->
      <button
        v-if="distant !== true"
        type="button"
        class="shrink-0 cursor-pointer rounded border border-transparent px-1.5 py-0.5 text-[13px] leading-none opacity-60 hover:border-bord hover:opacity-100"
        aria-label="Vérifier les enregistrements"
        title="Lister, contrôler et prévisualiser les enregistrements déjà produits"
        data-role="btn-vod"
        @click="emit('vod')"
      >
        🎞
      </button>
    </div>

    <div v-if="distant !== true" class="mb-2 flex items-baseline gap-2.5">
      <RecordingTimer :recording="recording" :real-ms="realMs" :room-ms="roomMs" />
      <span class="text-[11px] text-attenue" data-role="markers">{{ markers }}</span>
    </div>

    <!--
      À distance, le témoin sans la durée : ce que le hub sait vraiment.
      Un chronomètre demanderait l'heure de départ, que `room_state` ne porte
      pas — et une durée inventée à côté d'un point rouge juste ferait douter
      des deux.
    -->
    <div v-else class="mb-2 text-sm" :class="active ? 'text-alerte' : 'text-attenue'">
      {{ active ? 'Enregistrement en cours' : 'Aucun enregistrement' }}
    </div>

    <div class="grid grid-cols-2 gap-1.5">
      <Button
        id="btn-rec"
        variant="danger"
        :active="active"
        @click="toggleRecording()"
      >
        {{ active ? 'Arrêter' : 'Enregistrer' }}<Key v-if="distant !== true">R</Key>
      </Button>
      <Button id="btn-stream" :active="streaming" @click="toggleStream()">
        {{ streaming ? 'Arrêter la diffusion' : 'Diffuser' }}
      </Button>
    </div>

    <!--
      Les deux repères, au-dessus du champ de libellé et sous « Enregistrer ».

      Ils appartiennent à la prise, pas au chapitrage : ce sont eux qui décident
      de ce que le editing publiera, et les ranger sous le champ de saisie les
      aurait fait lire comme deux libellés tout faits parmi d'autres. Le
      décalage s'affiche dès qu'ils sont posés — reposer corrige, et il faut
      pouvoir voir ce qu'on corrige.
    -->
    <div v-if="distant !== true" class="mt-1.5 grid grid-cols-2 gap-1.5">
      <Button
        id="btn-repere-debut"
        size="small"
        :active="editing.startMs != null"
        :disabled="!active"
        title="Là où commence ce qu'on publie : le editing coupe tout ce qui précède. Reposer remplace le repère précédent."
        data-role="repere-debut"
        @click="repere('debut')"
      >
        {{ repereLabel('Début', editing.startMs) }}<Key>D</Key>
      </Button>
      <Button
        id="btn-repere-fin"
        size="small"
        :active="editing.endMs != null"
        :disabled="!active"
        title="Là où finit ce qu'on publie : le editing coupe tout ce qui suit. Reposer remplace le repère précédent."
        data-role="repere-fin"
        @click="repere('fin')"
      >
        {{ repereLabel('Fin', editing.endMs) }}<Key>F</Key>
      </Button>
    </div>

    <div v-if="distant !== true" class="mt-1.5 flex gap-1.5">
      <input
        id="label-marqueur"
        v-model="label"
        type="text"
        maxlength="80"
        placeholder="Libellé du marqueur"
        class="flex-1 rounded-lg border border-bord bg-fond px-3 py-2 text-sm text-texte focus:border-marque focus:outline-none"
        :disabled="!active"
        @keydown.enter="active && mark()"
      />
      <Button id="btn-marqueur" class="shrink-0" size="small" :disabled="!active" @click="mark()">
        Marquer<Key>M</Key>
      </Button>
    </div>
  </Panel>
</template>
