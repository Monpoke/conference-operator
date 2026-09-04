<script setup lang="ts">
import { Button, ConfirmDialog, Empty, Hint, Panel, useToast } from '@cloudnord/components'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useSeededField } from '../composables/seededField.js'
import {
  STORAGE_STEPS,
  orNull,
  useSettingsStore,
  type SocialLink,
  type StorageCheck,
} from '../stores/settings.js'

/**
 * What is set once, and holds for the day.
 *
 * Six panels sharing one constraint: the view refreshes every ten seconds, and
 * **no field must rewrite itself while somebody is typing in it**. It is
 * `useSeededField` that holds that, rather than a focus check copied into every
 * panel.
 */
const store = useSettingsStore()
const { settings, derived, snapshots, rooms, storage } = storeToRefs(store)
const toast = useToast()

// — The event —
const name = useSeededField(() => settings.value?.eventName ?? '', 'event-name')
const shortName = useSeededField(() => settings.value?.eventShortName ?? '', 'event-short-name')
const project = useSeededField(
  () => settings.value?.openFeedbackProjectId ?? '',
  'event-openfeedback',
)

/**
 * The fields stay empty when nothing is set.
 *
 * The placeholder then shows what the hub deduced from the program. A field
 * pre-filled with the deduced value would suggest it is pinned, and the first save
 * would in fact have pinned it — the name would stop following later imports.
 */
const eventHelp = computed(() =>
  settings.value?.eventName
    ? `Nom imposé ici : il ne suivra plus les imports de programme. Videz le champ pour revenir à « ${derived.value.name} ».`
    : `Déduit du programme importé (« ${derived.value.name} »). Renseignez un nom pour contredire l'export amont.`,
)

async function saveEvent(): Promise<void> {
  try {
    await store.update({
      eventName: orNull(name.value.value),
      eventShortName: orNull(shortName.value.value),
      openFeedbackProjectId: orNull(project.value.value),
    })
    toast.say('Événement enregistré')
  } catch {
    /* already reported */
  }
}

// — Program —
const programUrl = useSeededField(() => settings.value?.programSourceUrl ?? '', 'program-url')

/**
 * "Réimporter" starts from the **saved** URL, not the one on screen.
 *
 * The button is therefore blocked while the two differ: without that, one types a
 * new address, clicks Réimporter, and the hub reads the old one with nothing to
 * say so.
 */
const pendingSource = computed(
  () => programUrl.value.value.trim() !== (settings.value?.programSourceUrl ?? ''),
)

const canReimport = computed(
  () => settings.value?.programSourceUrl != null && !pendingSource.value,
)

const reimportTitle = computed(() =>
  settings.value?.programSourceUrl == null
    ? 'Renseignez une URL, puis enregistrez'
    : pendingSource.value
      ? "Enregistrez d'abord : l'import part de l'URL enregistrée"
      : settings.value.programSourceUrl,
)

async function saveSource(): Promise<void> {
  try {
    // Emptied means no source. The hub then imports nothing by itself, which is a
    // legitimate state: a program already in the database goes on serving.
    await store.update({ programSourceUrl: orNull(programUrl.value.value) })
    toast.say('Source du programme enregistrée')
  } catch {
    /* already reported */
  }
}

async function reimport(): Promise<void> {
  try {
    // The session count, not "imported": it is the only figure that says whether
    // the export at the other end really contained what one thought.
    toast.say(`${await store.reimport()} sessions importées`)
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('Aucune URL')) toast.fail(cause.message)
  }
}

async function activate(contentHash: string): Promise<void> {
  try {
    // A failed import on the day is rolled back with one click.
    await store.activate(contentHash)
    toast.say('Programme activé')
  } catch {
    /* already reported */
  }
}

// — Our social links —
const socialLinks = ref<SocialLink[]>([])

watch(
  () => settings.value?.socialLinks,
  (links) => {
    // The same precaution as the fields: do not rewrite the list while somebody is
    // typing in it.
    const area = globalThis.document?.getElementById('socials')
    if (area != null && area.contains(globalThis.document.activeElement)) return
    socialLinks.value = (links ?? []).map((link) => ({ ...link }))
  },
  { immediate: true, deep: true },
)

async function saveSocialLinks(): Promise<void> {
  // Empty rows are dropped here: adding a row and then thinking better of it is a
  // normal gesture, and the hub would refuse an empty URL.
  const filled = socialLinks.value.filter(
    (link) => link.network.trim() !== '' && link.handle.trim() !== '' && link.url.trim() !== '',
  )
  try {
    await store.update({ socialLinks: filled })
    toast.say('Réseaux enregistrés')
  } catch {
    /* already reported */
  }
}

// — Automatic closure —
const autoEnabled = ref(false)
const autoGrace = ref(5)

watch(
  settings,
  (value) => {
    if (value == null) return
    autoEnabled.value = value.autoEndEnabled
    if (globalThis.document?.activeElement?.id !== 'auto-grace') {
      autoGrace.value = value.autoEndGraceMinutes
    }
  },
  { immediate: true },
)

async function saveAutoEnd(): Promise<void> {
  try {
    await store.update({
      autoEndEnabled: autoEnabled.value,
      autoEndGraceMinutes: Number(autoGrace.value),
    })
    toast.say('Réglages enregistrés')
  } catch {
    /* already reported */
  }
}

// — Storage —
const bucket = useSeededField(() => storage.value?.bucket ?? '', 'vod-bucket')
const prefix = useSeededField(() => storage.value?.prefix ?? '', 'vod-prefix')
const vodAuto = ref(false)
const rate = ref('')
const cpu = ref(80)
const margin = ref(5)
const part = ref(16)

watch(
  storage,
  (value) => {
    if (value == null) return
    // `politique` and its fields are the contract's own names: not renamed.
    const policy = value.politique
    vodAuto.value = policy.actif
    rate.value =
      policy.debitMaxOctetsS == null ? '' : String(Math.round(policy.debitMaxOctetsS / 1024))
    cpu.value = Math.round(policy.cpuMax * 100)
    margin.value = policy.margeConferenceMinutes
    part.value = policy.taillePartMo
  },
  { immediate: true },
)

async function saveStorage(): Promise<void> {
  try {
    await store.update({
      vodBucket: orNull(bucket.value.value),
      vodPrefix: orNull(prefix.value.value),
      vodPolitique: {
        actif: vodAuto.value,
        debitMaxOctetsS: rate.value === '' || Number(rate.value) <= 0 ? null : Number(rate.value) * 1024,
        cpuMax: Math.min(1, Math.max(0.1, Number(cpu.value) / 100)),
        margeConferenceMinutes: Number(margin.value),
        taillePartMo: Number(part.value),
      },
    })
    toast.say('Stockage enregistré')
  } catch {
    /* already reported */
  }
}

const check = ref<StorageCheck | null>(null)
const checking = ref(false)

async function probeStorage(): Promise<void> {
  checking.value = true
  check.value = null
  try {
    check.value = await store.checkStorage()
  } catch {
    /* already reported */
  } finally {
    checking.value = false
  }
}

// — Resynchronisation —
const resyncRoom = ref('')
const resyncConfirmation = ref(false)

const resyncRoomName = computed(
  () => rooms.value.find((room) => room.id === resyncRoom.value)?.name ?? null,
)

async function confirmResync(): Promise<void> {
  try {
    const result = await store.resync(resyncRoom.value === '' ? null : resyncRoom.value)
    /*
     * The number of rooms targeted, not a "it's off". A hub with no paired room at
     * all accepts the request with nothing leaving: saying "requested" would then be
     * exact and misleading.
     */
    toast.say(
      resyncRoomName.value != null
        ? `Resynchronisation demandée à ${resyncRoomName.value}`
        : result.rooms === 0
          ? "Aucune salle sur ce hub : la demande n'atteindra personne"
          : `Resynchronisation demandée à ${result.rooms} salle(s)`,
    )
  } catch {
    /* already reported */
  }
}
</script>

<template>
  <div
    id="settings-view"
    class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] items-start gap-3.5"
  >
    <Panel title="L'événement">
      <label class="mb-[5px] block text-xs text-dim" for="event-name">Nom affiché</label>
      <input
        id="event-name"
        v-model="name.value.value"
        type="text"
        maxlength="80"
        :placeholder="derived.name"
        class="mb-[11px] w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text focus:border-brand focus:outline-none"
      />
      <label class="mb-[5px] block text-xs text-dim" for="event-short-name">Nom court</label>
      <input
        id="event-short-name"
        v-model="shortName.value.value"
        type="text"
        maxlength="40"
        :placeholder="derived.shortName"
        class="mb-[11px] w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text focus:border-brand focus:outline-none"
      />
      <label class="mb-[5px] block text-xs text-dim" for="event-openfeedback">
        Projet OpenFeedback
      </label>
      <input
        id="event-openfeedback"
        v-model="project.value.value"
        type="text"
        maxlength="80"
        placeholder="mon-evenement-2026"
        class="mb-[11px] w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text focus:border-brand focus:outline-none"
      />
      <Button id="btn-event" variant="primary" class="w-full" @click="saveEvent">
        Enregistrer
      </Button>
      <Hint id="event-help">{{ eventHelp }}</Hint>
    </Panel>

    <Panel title="Programme">
      <label class="mb-[5px] block text-xs text-dim" for="program-url">
        URL de l'export « conference-center »
      </label>
      <input
        id="program-url"
        v-model="programUrl.value.value"
        type="url"
        placeholder="https://…/programme.json"
        class="mb-[11px] w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text focus:border-brand focus:outline-none"
      />
      <div class="mb-[11px] flex gap-1.5">
        <Button id="btn-program-source" variant="primary" size="small" @click="saveSource">
          Enregistrer
        </Button>
        <Button
          id="btn-reimport"
          size="small"
          :disabled="!canReimport"
          :title="reimportTitle"
          @click="reimport"
        >
          Réimporter
        </Button>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full border-collapse text-[13px]">
          <thead>
            <tr class="text-[11px] tracking-[.08em] text-dim uppercase">
              <th class="pr-2.5 pb-2 text-left font-semibold">Version</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">Créneaux</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">Anomalies</th>
              <th class="pb-2"></th>
            </tr>
          </thead>
          <tbody id="snapshots">
            <tr v-if="snapshots.length === 0">
              <td colspan="4"><Empty>Aucun programme importé.</Empty></td>
            </tr>
            <tr
              v-for="snapshot in snapshots"
              v-else
              :key="snapshot.contentHash"
              :data-snapshot="snapshot.contentHash"
            >
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle font-mono text-[11px]">
                <span v-if="snapshot.active" class="text-ok">● actif </span>
                {{ snapshot.contentHash.slice(0, 10) }}
              </td>
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle">
                {{ snapshot.sessionCount }}
              </td>
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle">
                {{ snapshot.issueCount > 0 ? snapshot.issueCount : '—' }}
              </td>
              <td class="border-t border-edge py-[9px] align-middle">
                <!-- A failed import on the day is rolled back with one click. -->
                <Button
                  v-if="!snapshot.active"
                  size="small"
                  @click="activate(snapshot.contentHash)"
                >
                  Activer
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>

    <Panel title="Nos réseaux">
      <div id="socials">
        <Empty v-if="socialLinks.length === 0">
          Aucun compte déclaré. La boucle des salles saute cette page.
        </Empty>
        <div
          v-for="(link, index) in socialLinks"
          :key="index"
          class="mb-1.5 grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,2fr)_auto] items-center gap-1.5"
        >
          <input
            v-model="link.network"
            placeholder="Réseau"
            class="min-w-0 rounded-lg border border-edge bg-canvas px-2 py-1.5 text-sm text-text"
          />
          <input
            v-model="link.handle"
            placeholder="@handle"
            class="min-w-0 rounded-lg border border-edge bg-canvas px-2 py-1.5 text-sm text-text"
          />
          <input
            v-model="link.url"
            placeholder="https://…"
            class="min-w-0 rounded-lg border border-edge bg-canvas px-2 py-1.5 text-sm text-text"
          />
          <Button variant="danger" size="small" title="Retirer ce compte" @click="socialLinks.splice(index, 1)">
            ×
          </Button>
        </div>
      </div>
      <div class="mt-2 flex gap-1.5">
        <Button id="btn-social-add" size="small" @click="socialLinks.push({ network: '', handle: '', url: '' })">
          Ajouter un compte
        </Button>
        <Button id="btn-social-links" variant="primary" size="small" @click="saveSocialLinks">
          Enregistrer
        </Button>
      </div>
    </Panel>

    <Panel title="Clôture automatique">
      <div class="flex items-center gap-3 border-b border-edge pb-3">
        <div class="flex-1">
          <strong class="mb-[3px] block text-sm">Clôturer les conférences dépassées</strong>
          <span class="text-xs text-dim">
            Sans elle, un talk lancé reste « en cours » indéfiniment.
          </span>
        </div>
        <input id="auto-enabled" v-model="autoEnabled" type="checkbox" class="w-auto" />
      </div>
      <div class="flex items-baseline gap-3 pt-3">
        <label class="flex-1" for="auto-grace">
          <strong class="mb-[3px] block text-sm">Délai de grâce</strong>
          <span class="text-xs text-dim">Minutes après la fin du créneau avant clôture.</span>
        </label>
      </div>
      <input
        id="auto-grace"
        v-model="autoGrace"
        type="number"
        min="0"
        max="120"
        class="w-[92px] rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text"
      />
      <Button id="btn-auto-end" variant="primary" class="mt-3 w-full" @click="saveAutoEnd">
        Enregistrer
      </Button>
    </Panel>

    <Panel title="Stockage">
      <Hint id="vod-state" class="mt-0 mb-3">
        <template v-if="storage?.endpoint == null">
          <!-- No keys: nothing to set here, and saying so stops people filling in
               le formulaire en se demandant pourquoi rien ne part. -->
          Aucun stockage S3 configuré sur ce hub. Les clés se posent dans son environnement
          (<code>S3_ENDPOINT</code>, <code>S3_ACCESS_KEY_ID</code>,
          <code>S3_SECRET_ACCESS_KEY</code>) et demandent un redémarrage — c'est le seul réglage
          de cette page qui ne se change pas en cours d'événement.
        </template>
        <template v-else-if="!storage.configure">
          <!-- The most confusing of the three: the keys are there, the page is
               ouverte, et rien ne part parce qu'il manque un name de bucket. -->
          Clés en place sur <strong>{{ storage.endpoint }}</strong>, mais
          <strong>aucun bucket</strong> : renseignez-le ci-dessous.
        </template>
        <template v-else>
          Stockage prêt sur <strong>{{ storage.endpoint }}</strong>, bucket
          <strong>{{ storage.bucket }}</strong>.
          <template v-if="!storage.politique.actif">
            Le téléversement automatique est éteint : rien ne part sans demande.
          </template>
        </template>
      </Hint>

      <label class="mb-[5px] block text-xs text-dim" for="vod-bucket">Bucket</label>
      <input
        id="vod-bucket"
        v-model="bucket.value.value"
        type="text"
        maxlength="200"
        placeholder="rushes-cloudnord"
        class="mb-[11px] w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text"
      />
      <label class="mb-[5px] block text-xs text-dim" for="vod-prefix">Préfixe</label>
      <input
        id="vod-prefix"
        v-model="prefix.value.value"
        type="text"
        maxlength="200"
        placeholder="cn26"
        class="mb-[11px] w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text"
      />

      <label class="mb-2 flex items-center gap-2 text-sm">
        <input id="vod-auto" v-model="vodAuto" type="checkbox" class="w-auto" />
        Téléverser automatiquement
      </label>

      <div class="grid grid-cols-2 gap-2">
        <div>
          <label class="mb-[5px] block text-xs text-dim" for="vod-rate">Débit max (Ko/s)</label>
          <input id="vod-rate" v-model="rate" type="number" min="0" max="1000000"
            class="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text" />
        </div>
        <div>
          <label class="mb-[5px] block text-xs text-dim" for="vod-cpu">CPU max (%)</label>
          <input id="vod-cpu" v-model="cpu" type="number" min="10" max="100"
            class="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text" />
        </div>
        <div>
          <label class="mb-[5px] block text-xs text-dim" for="vod-margin">Marge (min)</label>
          <input id="vod-margin" v-model="margin" type="number" min="0" max="120"
            class="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text" />
        </div>
        <div>
          <label class="mb-[5px] block text-xs text-dim" for="vod-part">Taille de part (Mo)</label>
          <input id="vod-part" v-model="part" type="number" min="5" max="64"
            class="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text" />
        </div>
      </div>

      <div class="mt-3 flex gap-1.5">
        <Button id="btn-vod-save" variant="primary" size="small" @click="saveStorage">
          Enregistrer
        </Button>
        <!-- The button only makes sense if the hub has keys: without them there is
             a rien à éprouver, et le panneau le dit déjà en haut. -->
        <Button
          id="btn-vod-probe"
          size="small"
          :disabled="storage?.endpoint == null || checking"
          @click="probeStorage"
        >
          Éprouver la connexion
        </Button>
      </div>

      <div id="vod-check" class="mt-2">
        <!-- The check makes four network round trips: without this word, one
             croit que le bouton n'a rien fait et on reclique. -->
        <Hint v-if="checking" class="mt-0">Contrôle en cours…</Hint>
        <div
          v-else-if="check != null"
          class="rounded-lg border p-2"
          :class="check.ok ? 'border-edge' : 'border-alert/40'"
        >
          <div
            class="mb-1 text-[11px] font-semibold tracking-[.08em] uppercase"
            :class="check.ok ? 'text-dim' : 'text-alert'"
          >
            {{ check.ok ? 'Stockage joignable et accessible en écriture' : 'Contrôle interrompu' }}
          </div>
          <!-- The last step attempted carries the reason; the earlier ones say
               jusqu'où on est allé, ce qui est la moitié de l'information. -->
          <div
            v-for="step in check.etapes"
            :key="step.nom"
            class="flex items-baseline gap-2 text-[12px]"
          >
            <span>{{ step.ok ? '✓' : '✗' }}</span>
            <span :class="step.ok ? '' : 'text-alert'">
              {{ STORAGE_STEPS[step.nom] ?? step.nom }}
            </span>
            <span v-if="step.detail != null" class="min-w-0 flex-1 break-words text-dim">
              {{ step.detail }}
            </span>
          </div>
        </div>
      </div>
    </Panel>

    <Panel title="Resynchronisation des salles">
      <label class="mb-[5px] block text-xs text-dim" for="resync-room">
        Salle à resynchroniser
      </label>
      <select
        id="resync-room"
        v-model="resyncRoom"
        class="mb-3 w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text"
      >
        <option value="">Toutes les salles</option>
        <option v-for="room in rooms" :key="room.id" :value="room.id">{{ room.name }}</option>
      </select>
      <Button id="btn-resync" class="w-full" @click="resyncConfirmation = true">
        Demander une resynchronisation
      </Button>
    </Panel>

    <ConfirmDialog
      v-model:open="resyncConfirmation"
      title="Resynchronisation"
      confirm-label="Demander"
      @confirm="confirmResync"
    >
      <span id="resync-text">
        Demander une resynchronisation complète à
        <strong>{{ resyncRoomName ?? 'toutes les salles' }}</strong>.
      </span>
    </ConfirmDialog>
  </div>
</template>
