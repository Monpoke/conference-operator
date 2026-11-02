<script setup lang="ts">
import { Button, Hint, Panel, StableLabel, useToast } from '@conference-operator/components'
import { timeAgo } from '@conference-operator/format'
import { storeToRefs } from 'pinia'
import { onMounted, ref, watch } from 'vue'
import { useConfirmStore } from '../../stores/confirm.js'
import { useMurPublicStore } from '../../stores/murPublic.js'
import { useSettingsStore } from '../../stores/settings.js'
import { useWallsIoStore } from '../../stores/wallsio.js'

/**
 * Réglages, Public: what the audience can do, and the social wall's sources.
 *
 * Mounted with its siblings and only hidden: a draft survives a change of section.
 */
const store = useSettingsStore()
const { settings } = storeToRefs(store)
const toast = useToast()

// — Public wall & questions —
const wallOn = ref(true)
const questionsOn = ref(true)

watch(
  settings,
  (value) => {
    if (value == null) return
    wallOn.value = value.wallEnabled ?? true
    questionsOn.value = value.questionsEnabled ?? true
  },
  { immediate: true },
)

async function saveFeatures(): Promise<void> {
  try {
    await store.update({ wallEnabled: wallOn.value, questionsEnabled: questionsOn.value })
    toast.say('Réglages enregistrés')
  } catch {
    /* already reported */
  }
}

// — walls.io —
/**
 * Typed, sent, emptied: the token never comes back to fill the field, only
 * whether there is one and its last characters.
 */
const wallsIo = useWallsIoStore()
const { status: wallsIoStatus } = storeToRefs(wallsIo)
const wallsIoToken = ref('')
const wallsIoBusy = ref(false)
onMounted(() => {
  void wallsIo.load().catch(() => {})
})

async function saveWallsIoToken(token: string | null): Promise<void> {
  wallsIoBusy.value = true
  try {
    const status = await wallsIo.setToken(token)
    wallsIoToken.value = ''
    if (token == null) toast.say('Jeton walls.io retiré')
    else if (status.lastError != null) toast.fail(status.lastError)
    else toast.say(`Jeton walls.io enregistré : ${status.imported} post(s) sur le mur`)
  } catch {
    /* already reported */
  } finally {
    wallsIoBusy.value = false
  }
}

async function toggleWallsIoPause(): Promise<void> {
  const paused = !(wallsIoStatus.value?.paused ?? false)
  wallsIoBusy.value = true
  try {
    const status = await wallsIo.setPaused(paused)
    if (paused) toast.say('Lecture de walls.io en pause : le mur garde ses posts')
    else if (status.lastError != null) toast.fail(status.lastError)
    else toast.say('Lecture de walls.io reprise')
  } catch {
    /* already reported */
  } finally {
    wallsIoBusy.value = false
  }
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
}

// — Public page's token —
/** Shown once, right after it is created, then gone with the page. */
const confirmStore = useConfirmStore()
const murPublic = useMurPublicStore()
const { status: murPublicStatus } = storeToRefs(murPublic)
const murPublicToken = ref<string | null>(null)
const murPublicBusy = ref(false)
onMounted(() => {
  void murPublic.load().catch(() => {})
})

async function createMurPublicToken(): Promise<void> {
  if (murPublicStatus.value?.hasToken && !(await confirmStore.ask({ title: 'Remplacer le jeton ?', message: 'L’ancien cesse aussitôt de fonctionner : il faudra mettre le nouveau dans le secret du service mur-public.', confirmLabel: 'Remplacer', danger: true }))) return
  murPublicBusy.value = true
  try {
    murPublicToken.value = await murPublic.createToken()
  } catch {
    /* already reported */
  } finally {
    murPublicBusy.value = false
  }
}

async function removeMurPublicToken(): Promise<void> {
  murPublicBusy.value = true
  try {
    await murPublic.removeToken()
    murPublicToken.value = null
    toast.say('Jeton du mur public retiré : les vues en ligne ne sont plus comptées')
  } catch {
    /* already reported */
  } finally {
    murPublicBusy.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-3.5">
    <Panel title="Mur public & questions">
      <div class="flex items-center gap-3 border-b border-edge pb-3">
        <div class="flex-1">
          <strong class="mb-[3px] block text-sm">Mur public</strong>
          <span class="text-xs text-dim">
            Le formulaire de message de la page /mur. Désactivé, la page ne le propose plus et la
            régie retire ses boutons. Le mur social de la boucle (walls.io) n'est pas concerné.
          </span>
        </div>
        <input id="wall-enabled" v-model="wallOn" type="checkbox" class="w-auto" />
      </div>
      <div class="flex items-center gap-3 pt-3">
        <div class="flex-1">
          <strong class="mb-[3px] block text-sm">Questions du public</strong>
          <span class="text-xs text-dim">
            L'onglet Questions de /mur, les votes et la « question à l'antenne » en régie.
          </span>
        </div>
        <input id="questions-enabled" v-model="questionsOn" type="checkbox" class="w-auto" />
      </div>
      <Hint class="mt-2">
        Les deux désactivés : /mur affiche une page fermée et les écrans ne montrent plus de QR code
        vers le mur. Les salles l'appliquent à leur prochaine synchronisation.
      </Hint>
      <Button id="btn-features" variant="primary" size="small" class="mt-3 self-start" @click="saveFeatures">
        Enregistrer
      </Button>
    </Panel>

    <Panel title="Mur social — walls.io">
      <p class="mb-2 text-[13px] text-dim">
        Le hub lit les posts du mur walls.io par son API et les ajoute au mur social de la
        boucle, déjà modérés par walls.io. Le jeton d'accès se trouve dans les réglages du mur,
        sur walls.io. Il est chiffré sur le hub et ne descend jamais en salle.
      </p>
      <label class="mb-[5px] block text-xs text-dim" for="walls-io-token">Jeton d'accès API</label>
      <input
        id="walls-io-token"
        v-model="wallsIoToken"
        type="password"
        autocomplete="off"
        :placeholder="wallsIoStatus?.hasToken ? `Jeton enregistré (…${wallsIoStatus.tokenHint ?? ''})` : 'Aucun jeton'"
        class="mb-2 w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text"
      />
      <p id="walls-io-status" class="mb-3 text-[13px] text-dim">
        <template v-if="wallsIoStatus?.hasToken">
          {{ wallsIoStatus.imported }} post(s) walls.io sur le mur<template v-if="wallsIoStatus.lastPollAt">
            — dernière lecture {{ timeAgo(wallsIoStatus.lastPollAt) }}</template>.
          <strong v-if="wallsIoStatus.paused" data-role="walls-io-paused">Lecture en pause.</strong>
          <span v-if="wallsIoStatus.lastError" class="text-alert">{{ wallsIoStatus.lastError }}</span>
          <span v-if="!wallsIoStatus.paused && wallsIoStatus.retryAt" data-role="walls-io-retry">
            — {{ wallsIoStatus.failures }} échec(s) de suite, prochain essai à {{ clockTime(wallsIoStatus.retryAt) }}.
          </span>
        </template>
        <template v-else>Sans jeton, le mur social montre les messages du public et les posts partenaires.</template>
      </p>
      <div class="flex gap-2">
        <Button
          id="btn-walls-io-token"
          variant="primary"
          size="small"
          :disabled="wallsIoBusy || wallsIoToken.trim().length < 8"
          @click="saveWallsIoToken(wallsIoToken.trim())"
        >
          Enregistrer
        </Button>
        <Button
          v-if="wallsIoStatus?.hasToken"
          id="btn-walls-io-clear"
          size="small"
          :disabled="wallsIoBusy"
          @click="saveWallsIoToken(null)"
        >
          Retirer le jeton
        </Button>
        <Button
          v-if="wallsIoStatus?.hasToken"
          id="btn-walls-io-pause"
          size="small"
          :disabled="wallsIoBusy"
          @click="toggleWallsIoPause"
        >
          <StableLabel :current="wallsIoStatus.paused ? 'Reprendre la lecture' : 'Mettre en pause la lecture'" :labels="['Reprendre la lecture', 'Mettre en pause la lecture']" />
        </Button>
      </div>
    </Panel>

    <Panel title="Mur social — page publique">
      <p class="mb-2 text-[13px] text-dim">
        La page publique du mur compte les posts que ses visiteurs ont vus (une carte visible
        au moins une seconde, une fois par visite) et les envoie au hub, à côté des affichages
        en salle. Le service s'identifie avec ce jeton, à mettre dans son secret
        (<code>HUB_TOKEN</code>). Le hub n'en garde qu'une empreinte : il n'est montré qu'une fois.
      </p>
      <p id="mur-public-status" class="mb-3 text-[13px] text-dim">
        <template v-if="murPublicStatus?.hasToken">
          Jeton enregistré (…{{ murPublicStatus.tokenHint }})<template v-if="murPublicStatus.lastReportAt">
            — dernier envoi de vues {{ timeAgo(murPublicStatus.lastReportAt) }}</template
          ><template v-else> — aucun envoi de vues pour l'instant</template>.
        </template>
        <template v-else>Sans jeton, la page fonctionne mais ses vues ne sont pas comptées.</template>
      </p>
      <div v-if="murPublicToken" class="mb-3">
        <label class="mb-[5px] block text-xs text-dim" for="mur-public-token">
          Nouveau jeton — copiez-le maintenant, il ne sera plus affiché
        </label>
        <input
          id="mur-public-token"
          :value="murPublicToken"
          readonly
          class="w-full rounded-lg border border-edge bg-canvas px-3 py-2 font-mono text-sm text-text"
          @focus="($event.target as HTMLInputElement).select()"
        />
      </div>
      <div class="flex gap-2">
        <Button id="btn-mur-public-token" variant="primary" size="small" :disabled="murPublicBusy" @click="createMurPublicToken">
          <StableLabel :current="murPublicStatus?.hasToken ? 'Remplacer le jeton' : 'Créer un jeton'" :labels="['Remplacer le jeton', 'Créer un jeton']" />
        </Button>
        <Button
          v-if="murPublicStatus?.hasToken"
          id="btn-mur-public-clear"
          size="small"
          :disabled="murPublicBusy"
          @click="removeMurPublicToken"
        >
          Retirer le jeton
        </Button>
      </div>
    </Panel>
  </div>
</template>
