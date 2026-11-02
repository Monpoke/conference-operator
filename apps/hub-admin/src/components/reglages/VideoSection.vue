<script setup lang="ts">
import { Button, Hint, Panel, useToast } from '@conference-operator/components'
import { DEFAULT_MONTAGE_SORTIE, type MontageSortie } from '@conference-operator/contract'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import MontageWorkersPanel from '../MontageWorkersPanel.vue'
import YoutubeSettingsPanel from '../YoutubeSettingsPanel.vue'
import { useSeededField } from '../../composables/seededField.js'
import { STORAGE_STEPS, orNull, useSettingsStore, type Settings, type StorageCheck } from '../../stores/settings.js'

/**
 * Réglages, Vidéo: where the rushes go, how they are edited, and where the videos leave for.
 *
 * Mounted with its siblings and only hidden: a draft survives a change of section.
 */
type MontageAuto = NonNullable<Settings['montageAuto']>

const store = useSettingsStore()
const { settings, storage } = storeToRefs(store)
const toast = useToast()

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

/** Saved on the choice; it applies to the next montage taken. */
const sortie = computed<MontageSortie>(() => settings.value?.montageSortie ?? DEFAULT_MONTAGE_SORTIE)
async function setSortie(patch: Partial<MontageSortie>): Promise<void> {
  try {
    await store.update({ montageSortie: { ...sortie.value, ...patch } })
    toast.say('Format de sortie enregistré')
  } catch {
    /* already reported */
  }
}

async function setMontageAuto(montageAuto: MontageAuto): Promise<void> {
  try {
    await store.update({ montageAuto })
    toast.say('Montage sans validation enregistré')
  } catch {
    /* already reported */
  }
}

async function saveBucket(): Promise<void> {
  try {
    await store.update({ vodBucket: orNull(bucket.value.value), vodPrefix: orNull(prefix.value.value) })
    toast.say('Stockage enregistré')
  } catch {
    /* already reported */
  }
}

/** Its own patch: saving the bucket must not send a rate still being typed. */
async function savePolicy(): Promise<void> {
  try {
    await store.update({
      vodPolitique: {
        actif: vodAuto.value,
        debitMaxOctetsS: rate.value === '' || Number(rate.value) <= 0 ? null : Number(rate.value) * 1024,
        cpuMax: Math.min(1, Math.max(0.1, Number(cpu.value) / 100)),
        margeConferenceMinutes: Number(margin.value),
        taillePartMo: Number(part.value),
      },
    })
    toast.say('Téléversement enregistré')
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
</script>

<template>
  <div class="flex flex-col gap-3.5">
    <Panel title="Stockage">
      <Hint id="vod-state" class="mt-0 mb-3">
        <template v-if="storage?.endpoint == null">
          <!-- No keys: nothing to set here, and saying so stops people filling in
               le formulaire en se demandant pourquoi rien ne part. -->
          Aucun stockage S3 configuré sur ce hub. Les clés se posent dans son environnement
          (<code>S3_ENDPOINT</code>, <code>S3_ACCESS_KEY_ID</code>,
          <code>S3_SECRET_ACCESS_KEY</code>) et demandent un redémarrage — c'est le seul réglage qui ne se change pas en cours d'événement.
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

      <div class="mt-3 flex gap-1.5">
        <Button id="btn-vod-bucket" variant="primary" size="small" @click="saveBucket">
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

    <Panel title="Téléversement">
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

      <div class="mt-3">
        <Button id="btn-vod-save" variant="primary" size="small" @click="savePolicy">
          Enregistrer
        </Button>
      </div>
    </Panel>

    <Panel title="Montage">
      <!--
        Le montage, pas le téléversement : ce réglage ne descend pas aux salles.
        Il décide quand une coupe analysée part au montage sans que personne
        l'ait regardée.
      -->
      <div>
        <label class="mb-[5px] block text-xs text-dim" for="vod-montage-auto">Montage sans validation</label>
        <select
          id="vod-montage-auto"
          :value="settings?.montageAuto ?? 'si-confiance-haute'"
          class="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text"
          @change="setMontageAuto(($event.target as HTMLSelectElement).value as MontageAuto)"
        >
          <option value="si-confiance-haute">Si la coupe est sûre (deux marques calées sur un silence)</option>
          <option value="jamais">Jamais : chaque coupe se valide dans le dossier du talk</option>
          <option value="toujours">Toujours : aucune coupe ne se valide</option>
        </select>
      </div>

      <!-- Des plafonds : un rush en dessous garde son format, rien n'est agrandi. -->
      <fieldset class="mt-3" data-role="montage-sortie">
        <legend class="mb-[5px] text-xs text-dim">Format des vidéos montées (au plus)</legend>
        <div class="grid grid-cols-3 gap-2">
          <select
            id="sortie-hauteur"
            aria-label="Définition"
            :value="sortie.hauteur"
            class="w-full rounded-lg border border-edge bg-canvas px-2 py-2 text-sm text-text"
            @change="setSortie({ hauteur: Number(($event.target as HTMLSelectElement).value) as MontageSortie['hauteur'] })"
          >
            <option v-for="h in [720, 1080, 1440, 2160]" :key="h" :value="h">{{ h }}p</option>
          </select>
          <select
            id="sortie-fps"
            aria-label="Cadence"
            :value="sortie.fps"
            class="w-full rounded-lg border border-edge bg-canvas px-2 py-2 text-sm text-text"
            @change="setSortie({ fps: Number(($event.target as HTMLSelectElement).value) as MontageSortie['fps'] })"
          >
            <option v-for="f in [25, 30, 50, 60]" :key="f" :value="f">{{ f }} i/s</option>
          </select>
          <select
            id="sortie-qualite"
            aria-label="Qualité"
            :value="sortie.crf"
            class="w-full rounded-lg border border-edge bg-canvas px-2 py-2 text-sm text-text"
            @change="setSortie({ crf: Number(($event.target as HTMLSelectElement).value) })"
          >
            <option :value="18">Haute (lourde)</option>
            <option :value="20">Standard</option>
            <option :value="23">Légère</option>
          </select>
        </div>
        <p class="mt-1 text-[11px] text-dim">
          Vaut pour les prochains montages. Plus de définition et de cadence demandent
          plus de mémoire au worker.
        </p>
      </fieldset>
    </Panel>

    <MontageWorkersPanel />

    <YoutubeSettingsPanel />
  </div>
</template>
