<script setup lang="ts">
import { BANNER_TEMPLATES, type Banner } from '@cloudnord/contract'
import { Badge, Button, Empty, Field, Hint, Panel, Select, useToast } from '@cloudnord/components'
import { timeAgo } from '@cloudnord/format'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useMessagesStore } from '../stores/messages.js'

/**
 * Ce que le hub adresse aux salles.
 *
 * Two gestures nothing brings together but the screen: a **message**, which takes
 * the whole room or speaks to the operator, and a **live banner**, which is
 * composited over the video without interrupting anything — that is the whole
 * difference, and
 * elle justifie que les deux ne se ressemblent pas.
 */
const store = useMessagesStore()
const { rooms, received, banners, target } = storeToRefs(store)
const toast = useToast()

const LEVELS = [
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Important' },
  { value: 'urgent', label: 'Urgent' },
]

const destinataires = computed(() => [
  { value: '', label: 'Toutes les salles' },
  ...rooms.value.map((salle) => ({ value: salle.id, label: salle.name })),
])

const texte = ref('')
const niveau = ref<'info' | 'warning' | 'urgent'>('info')
const cible = ref<'operator' | 'audience'>('operator')
const duree = ref('')

/**
 * Says where the message goes **before** it leaves.
 *
 * The confusion would cost dearly: a note to the operator projected in front of
 * the audience cannot be undone. The warning is therefore computed, not fired
 * par un `change` — c'est ce qui garantit qu'il est juste au premier rendu et
 * not only after the first interaction.
 */
const public_ = computed(() => cible.value === 'audience')

const bannerText = ref('')
const bannerLevel = ref<'info' | 'warning' | 'urgent'>('info')

/** Changing room changes the history being consulted. */
watch(target, () => void store.load())

async function envoyer(): Promise<void> {
  if (texte.value.trim().length === 0) {
    toast.fail('Renseignez un message')
    return
  }
  const minutes = Number(duree.value)
  try {
    await store.send({
      text: texte.value.trim(),
      level: niveau.value,
      audience: cible.value,
      minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : null,
    })
    texte.value = ''
    toast.say('Message envoyé')
  } catch {
    // Already reported by the client's error hook.
  }
}

/**
 * A template fills the field, it does not send.
 *
 * It is a starting point, not a rail: the date, the duration and the room's name
 * change every time.
 */
function appliquerModele(modele: Banner): void {
  bannerText.value = modele.text
  bannerLevel.value = modele.level
}

async function showBanner(): Promise<void> {
  if (bannerText.value.trim().length === 0) {
    toast.fail('Renseignez un texte')
    return
  }
  try {
    await store.showBanner({ text: bannerText.value.trim(), level: bannerLevel.value })
    toast.say('Bandeau affiché')
  } catch {
    /* already reported */
  }
}

async function hideBanner(): Promise<void> {
  try {
    await store.hideBanner()
    toast.say('Bandeau retiré')
  } catch {
    /* already reported */
  }
}
</script>

<template>
  <div
    id="messages-view"
    class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] items-start gap-3.5"
  >
    <Panel title="Envoyer un message">
      <Select id="msg-salle" v-model="target" label="Destinataire" :options="destinataires" />
      <Field id="msg-text" v-model="texte" label="Message" placeholder="Texte du message" />
      <Select
        id="msg-cible"
        v-model="cible"
        label="Qui le voit"
        :options="[
          { value: 'operator', label: `L'opérateur de la salle (bandeau de régie)` },
          { value: 'audience', label: 'Le public (écran de la salle)' },
        ]"
      />
      <Select id="msg-niveau" v-model="niveau" label="Niveau" :options="LEVELS" />
      <!--
        `inputmode` et non `type="number"` : Vue applique un cast numérique
        implicite aux `input[type=number]`, et rendait donc un `number` au
        `defineModel<string>` de `Field` — un avertissement à chaque frappe, et
        un modèle qui ment sur son type. Le champ reste numérique là où ça
        compte, le clavier du téléphone, et il peut être réellement vide : c'est
        cette valeur-là qui signifie « jusqu'à remplacement ».
      -->
      <Field
        id="msg-duree"
        v-model="duree"
        inputmode="numeric"
        label="Durée d'affichage (minutes, vide = jusqu'à remplacement)"
        placeholder="10"
      />
      <Button id="btn-envoyer-message" variant="primary" class="w-full" @click="envoyer">
        Envoyer
      </Button>

      <Hint id="msg-avertissement">
        <template v-if="public_">
          <strong class="text-warn">Ce message sera projeté devant le public</strong>
          et remplacera ce qui est à l'écran.
        </template>
        <template v-else>
          Ce message n'apparaîtra que dans le bandeau de la régie, pas sur l'écran de la salle.
        </template>
      </Hint>
    </Panel>

    <Panel title="Reçus des salles">
      <div id="messages-recus">
        <Empty v-if="received.length === 0">Aucun message des salles.</Empty>
        <article
          v-for="message in received"
          :key="message.id"
          class="mb-2.5 rounded-[9px] border border-edge p-3"
        >
          <div class="mb-1.5 flex items-center gap-2 text-xs text-dim">
            <Badge class="px-1.5 py-0.5 text-[10px] tracking-[.08em]">{{ message.level }}</Badge>
            <span>{{ message.roomName ?? message.roomId }}</span>
            <span>{{ timeAgo(message.receivedAt) }}</span>
          </div>
          <p class="text-sm leading-snug break-words">{{ message.text }}</p>
        </article>
      </div>
    </Panel>

    <!--
      Bandeau live : superposé à la vidéo, il n'interrompt rien — c'est toute
      la différence avec un message d'écran, qui prend la salle entière.
    -->
    <Panel class="col-span-full">
      <div class="mb-2.5 flex items-center gap-3">
        <h2 class="mb-0 flex-1 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
          Bandeau live
        </h2>
        <Button id="btn-bandeau-masquer" size="small" @click="hideBanner">
          Masquer le bandeau
        </Button>
      </div>

      <div id="bandeau-modeles" class="mb-[11px] flex flex-wrap gap-1.5">
        <Button
          v-for="modele in BANNER_TEMPLATES"
          :key="modele.name"
          size="small"
          @click="appliquerModele(modele.message)"
        >
          {{ modele.name }}
        </Button>
      </div>

      <div class="mb-[11px] flex gap-1.5">
        <input
          id="bandeau-text"
          v-model="bannerText"
          maxlength="240"
          placeholder="Texte du bandeau"
          class="flex-1 rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text focus:border-brand focus:outline-none"
        />
        <select
          id="bandeau-niveau"
          v-model="bannerLevel"
          class="w-auto shrink-0 rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text"
        >
          <option v-for="option in LEVELS" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
        <Button id="btn-bandeau-afficher" variant="primary" class="shrink-0" @click="showBanner">
          Afficher
        </Button>
      </div>

      <Hint>
        Part dans les salles choisies plus haut, et se superpose aux scènes live —
        le talk continue dessous. Un modèle remplit le champ : le texte reste
        modifiable avant envoi.
      </Hint>

      <h3 class="mt-3.5 mb-2.5 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
        Déjà passés
      </h3>
      <div id="bandeau-historique">
        <Empty v-if="banners.length === 0">Aucun bandeau diffusé pour le moment.</Empty>
        <div
          v-for="(passe, index) in banners"
          :key="`${passe.issuedAt}-${index}`"
          class="flex items-center gap-3 border-t border-edge py-3 first:border-t-0"
        >
          <div class="flex-1">
            <strong class="mb-[3px] block text-sm">{{ passe.message.text }}</strong>
            <span class="text-xs text-dim">
              {{ passe.message.level }} · {{ timeAgo(passe.issuedAt) }} ·
              {{ passe.roomId ?? 'toutes salles' }}
            </span>
          </div>
          <Badge v-if="passe.visible" variant="running">en cours</Badge>
          <Button
            size="small"
            @click="passe.visible ? hideBanner() : store.showBanner(passe.message)"
          >
            {{ passe.visible ? 'Masquer' : 'Remettre' }}
          </Button>
        </div>
      </div>
    </Panel>
  </div>
</template>
