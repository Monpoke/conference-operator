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
 * Ce qui se règle une fois, et vaut pour la journée.
 *
 * Six panneaux qui partagent une contrainte : la vue se rafraîchit toutes les
 * dix secondes, et **aucun champ ne doit se réécrire pendant qu'on tape
 * dedans**. C'est `useSeededField` qui la tient, plutôt qu'un test de focus
 * recopié dans chaque panneau.
 */
const store = useSettingsStore()
const { settings, derived, snapshots, rooms, storage } = storeToRefs(store)
const toast = useToast()

// — L'événement —
const nom = useSeededField(() => settings.value?.eventName ?? '', 'event-nom')
const nomCourt = useSeededField(() => settings.value?.eventShortName ?? '', 'event-nom-court')
const projet = useSeededField(
  () => settings.value?.openFeedbackProjectId ?? '',
  'event-openfeedback',
)

/**
 * Les champs restent vides quand rien n'est réglé.
 *
 * Le placeholder montre alors ce que le hub a déduit du programme. Un champ
 * pré-rempli avec la valeur déduite ferait croire qu'elle est figée, et le
 * premier enregistrement l'aurait effectivement figée — le nom cesserait de
 * suivre les imports suivants.
 */
const aideEvenement = computed(() =>
  settings.value?.eventName
    ? `Nom imposé ici : il ne suivra plus les imports de programme. Videz le champ pour revenir à « ${derived.value.name} ».`
    : `Déduit du programme importé (« ${derived.value.name} »). Renseignez un nom pour contredire l'export amont.`,
)

async function enregistrerEvenement(): Promise<void> {
  try {
    await store.update({
      eventName: orNull(nom.value.value),
      eventShortName: orNull(nomCourt.value.value),
      openFeedbackProjectId: orNull(projet.value.value),
    })
    toast.say('Événement enregistré')
  } catch {
    /* déjà remonté */
  }
}

// — Programme —
const urlProgramme = useSeededField(() => settings.value?.programSourceUrl ?? '', 'url-programme')

/**
 * « Réimporter » part de l'URL **enregistrée**, pas de celle qui est à l'écran.
 *
 * Le bouton est donc bloqué tant que les deux diffèrent : sans cela, on tape
 * une nouvelle adresse, on clique Réimporter, et le hub relit l'ancienne sans
 * que rien ne le dise.
 */
const sourceEnAttente = computed(
  () => urlProgramme.value.value.trim() !== (settings.value?.programSourceUrl ?? ''),
)

const reimportPossible = computed(
  () => settings.value?.programSourceUrl != null && !sourceEnAttente.value,
)

const titreReimport = computed(() =>
  settings.value?.programSourceUrl == null
    ? 'Renseignez une URL, puis enregistrez'
    : sourceEnAttente.value
      ? "Enregistrez d'abord : l'import part de l'URL enregistrée"
      : settings.value.programSourceUrl,
)

async function enregistrerSource(): Promise<void> {
  try {
    // Vidé = plus de source. Le hub n'importe alors plus rien tout seul, ce qui
    // est un état légitime : un programme déjà en base continue de servir.
    await store.update({ programSourceUrl: orNull(urlProgramme.value.value) })
    toast.say('Source du programme enregistrée')
  } catch {
    /* déjà remonté */
  }
}

async function reimporter(): Promise<void> {
  try {
    // Le nombre de sessions, pas « importé » : c'est le seul chiffre qui dit
    // si l'export d'en face contenait bien ce qu'on croyait.
    toast.say(`${await store.reimport()} sessions importées`)
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('Aucune URL')) toast.fail(cause.message)
  }
}

async function activer(contentHash: string): Promise<void> {
  try {
    // Un import raté le jour J se rollback en un clic.
    await store.activate(contentHash)
    toast.say('Programme activé')
  } catch {
    /* déjà remonté */
  }
}

// — Nos réseaux —
const reseaux = ref<SocialLink[]>([])

watch(
  () => settings.value?.socialLinks,
  (liens) => {
    // Même précaution que les champs : ne pas réécrire la liste pendant qu'on
    // tape dedans.
    const zone = globalThis.document?.getElementById('reseaux')
    if (zone != null && zone.contains(globalThis.document.activeElement)) return
    reseaux.value = (liens ?? []).map((lien) => ({ ...lien }))
  },
  { immediate: true, deep: true },
)

async function enregistrerReseaux(): Promise<void> {
  // Les lignes vides sont écartées ici : ajouter une ligne puis se raviser est
  // un geste normal, et le hub refuserait une URL vide.
  const propres = reseaux.value.filter(
    (lien) => lien.network.trim() !== '' && lien.handle.trim() !== '' && lien.url.trim() !== '',
  )
  try {
    await store.update({ socialLinks: propres })
    toast.say('Réseaux enregistrés')
  } catch {
    /* déjà remonté */
  }
}

// — Clôture automatique —
const autoActif = ref(false)
const autoDelai = ref(5)

watch(
  settings,
  (valeur) => {
    if (valeur == null) return
    autoActif.value = valeur.autoEndEnabled
    if (globalThis.document?.activeElement?.id !== 'auto-delai') {
      autoDelai.value = valeur.autoEndGraceMinutes
    }
  },
  { immediate: true },
)

async function enregistrerCloture(): Promise<void> {
  try {
    await store.update({
      autoEndEnabled: autoActif.value,
      autoEndGraceMinutes: Number(autoDelai.value),
    })
    toast.say('Réglages enregistrés')
  } catch {
    /* déjà remonté */
  }
}

// — Stockage —
const bucket = useSeededField(() => storage.value?.bucket ?? '', 'vod-bucket')
const prefixe = useSeededField(() => storage.value?.prefix ?? '', 'vod-prefixe')
const vodAuto = ref(false)
const debit = ref('')
const cpu = ref(80)
const marge = ref(5)
const part = ref(16)

watch(
  storage,
  (valeur) => {
    if (valeur == null) return
    const politique = valeur.politique
    vodAuto.value = politique.actif
    debit.value =
      politique.debitMaxOctetsS == null ? '' : String(Math.round(politique.debitMaxOctetsS / 1024))
    cpu.value = Math.round(politique.cpuMax * 100)
    marge.value = politique.margeConferenceMinutes
    part.value = politique.taillePartMo
  },
  { immediate: true },
)

async function enregistrerStockage(): Promise<void> {
  try {
    await store.update({
      vodBucket: orNull(bucket.value.value),
      vodPrefix: orNull(prefixe.value.value),
      vodPolitique: {
        actif: vodAuto.value,
        debitMaxOctetsS: debit.value === '' || Number(debit.value) <= 0 ? null : Number(debit.value) * 1024,
        cpuMax: Math.min(1, Math.max(0.1, Number(cpu.value) / 100)),
        margeConferenceMinutes: Number(marge.value),
        taillePartMo: Number(part.value),
      },
    })
    toast.say('Stockage enregistré')
  } catch {
    /* déjà remonté */
  }
}

const controle = ref<StorageCheck | null>(null)
const controleEnCours = ref(false)

async function eprouver(): Promise<void> {
  controleEnCours.value = true
  controle.value = null
  try {
    controle.value = await store.checkStorage()
  } catch {
    /* déjà remonté */
  } finally {
    controleEnCours.value = false
  }
}

// — Resynchronisation —
const salleResync = ref('')
const confirmationResync = ref(false)

const nomSalleResync = computed(
  () => rooms.value.find((salle) => salle.id === salleResync.value)?.name ?? null,
)

async function confirmerResync(): Promise<void> {
  try {
    const resultat = await store.resync(salleResync.value === '' ? null : salleResync.value)
    /*
     * Le nombre de salles visées, pas un « c'est parti ».
     *
     * Un hub sans aucune salle appairée accepte la demande sans que rien ne
     * parte : dire « demandé » serait alors exact et trompeur.
     */
    toast.say(
      nomSalleResync.value != null
        ? `Resynchronisation demandée à ${nomSalleResync.value}`
        : resultat.rooms === 0
          ? "Aucune salle sur ce hub : la demande n'atteindra personne"
          : `Resynchronisation demandée à ${resultat.rooms} salle(s)`,
    )
  } catch {
    /* déjà remonté */
  }
}
</script>

<template>
  <div
    id="vue-reglages"
    class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] items-start gap-3.5"
  >
    <Panel title="L'événement">
      <label class="mb-[5px] block text-xs text-dim" for="event-nom">Nom affiché</label>
      <input
        id="event-nom"
        v-model="nom.value.value"
        type="text"
        maxlength="80"
        :placeholder="derived.name"
        class="mb-[11px] w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text focus:border-brand focus:outline-none"
      />
      <label class="mb-[5px] block text-xs text-dim" for="event-nom-court">Nom court</label>
      <input
        id="event-nom-court"
        v-model="nomCourt.value.value"
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
        v-model="projet.value.value"
        type="text"
        maxlength="80"
        placeholder="mon-evenement-2026"
        class="mb-[11px] w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text focus:border-brand focus:outline-none"
      />
      <Button id="btn-event" variant="primary" class="w-full" @click="enregistrerEvenement">
        Enregistrer
      </Button>
      <Hint id="event-aide">{{ aideEvenement }}</Hint>
    </Panel>

    <Panel title="Programme">
      <label class="mb-[5px] block text-xs text-dim" for="url-programme">
        URL de l'export « conference-center »
      </label>
      <input
        id="url-programme"
        v-model="urlProgramme.value.value"
        type="url"
        placeholder="https://…/programme.json"
        class="mb-[11px] w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text focus:border-brand focus:outline-none"
      />
      <div class="mb-[11px] flex gap-1.5">
        <Button id="btn-source-programme" variant="primary" size="small" @click="enregistrerSource">
          Enregistrer
        </Button>
        <Button
          id="btn-reimporter"
          size="small"
          :disabled="!reimportPossible"
          :title="titreReimport"
          @click="reimporter"
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
                <!-- Un import raté le jour J se rollback en un clic. -->
                <Button
                  v-if="!snapshot.active"
                  size="small"
                  @click="activer(snapshot.contentHash)"
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
      <div id="reseaux">
        <Empty v-if="reseaux.length === 0">
          Aucun compte déclaré. La boucle des salles saute cette page.
        </Empty>
        <div
          v-for="(lien, index) in reseaux"
          :key="index"
          class="mb-1.5 grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,2fr)_auto] items-center gap-1.5"
        >
          <input
            v-model="lien.network"
            placeholder="Réseau"
            class="min-w-0 rounded-lg border border-edge bg-canvas px-2 py-1.5 text-sm text-text"
          />
          <input
            v-model="lien.handle"
            placeholder="@handle"
            class="min-w-0 rounded-lg border border-edge bg-canvas px-2 py-1.5 text-sm text-text"
          />
          <input
            v-model="lien.url"
            placeholder="https://…"
            class="min-w-0 rounded-lg border border-edge bg-canvas px-2 py-1.5 text-sm text-text"
          />
          <Button variant="danger" size="small" title="Retirer ce compte" @click="reseaux.splice(index, 1)">
            ×
          </Button>
        </div>
      </div>
      <div class="mt-2 flex gap-1.5">
        <Button id="btn-reseau-ajouter" size="small" @click="reseaux.push({ network: '', handle: '', url: '' })">
          Ajouter un compte
        </Button>
        <Button id="btn-reseaux" variant="primary" size="small" @click="enregistrerReseaux">
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
        <input id="auto-actif" v-model="autoActif" type="checkbox" class="w-auto" />
      </div>
      <div class="flex items-baseline gap-3 pt-3">
        <label class="flex-1" for="auto-delai">
          <strong class="mb-[3px] block text-sm">Délai de grâce</strong>
          <span class="text-xs text-dim">Minutes après la fin du créneau avant clôture.</span>
        </label>
      </div>
      <input
        id="auto-delai"
        v-model="autoDelai"
        type="number"
        min="0"
        max="120"
        class="w-[92px] rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text"
      />
      <Button id="btn-reglages" variant="primary" class="mt-3 w-full" @click="enregistrerCloture">
        Enregistrer
      </Button>
    </Panel>

    <Panel title="Stockage">
      <Hint id="vod-etat" class="mt-0 mb-3">
        <template v-if="storage?.endpoint == null">
          <!-- Pas de clés : rien à régler ici, et le dire évite qu'on remplisse
               le formulaire en se demandant pourquoi rien ne part. -->
          Aucun stockage S3 configuré sur ce hub. Les clés se posent dans son environnement
          (<code>S3_ENDPOINT</code>, <code>S3_ACCESS_KEY_ID</code>,
          <code>S3_SECRET_ACCESS_KEY</code>) et demandent un redémarrage — c'est le seul réglage
          de cette page qui ne se change pas en cours d'événement.
        </template>
        <template v-else-if="!storage.configure">
          <!-- Le cas le plus déroutant des trois : les clés sont là, la page est
               ouverte, et rien ne part parce qu'il manque un nom de bucket. -->
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
      <label class="mb-[5px] block text-xs text-dim" for="vod-prefixe">Préfixe</label>
      <input
        id="vod-prefixe"
        v-model="prefixe.value.value"
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
          <label class="mb-[5px] block text-xs text-dim" for="vod-debit">Débit max (Ko/s)</label>
          <input id="vod-debit" v-model="debit" type="number" min="0" max="1000000"
            class="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text" />
        </div>
        <div>
          <label class="mb-[5px] block text-xs text-dim" for="vod-cpu">CPU max (%)</label>
          <input id="vod-cpu" v-model="cpu" type="number" min="10" max="100"
            class="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text" />
        </div>
        <div>
          <label class="mb-[5px] block text-xs text-dim" for="vod-marge">Marge (min)</label>
          <input id="vod-marge" v-model="marge" type="number" min="0" max="120"
            class="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text" />
        </div>
        <div>
          <label class="mb-[5px] block text-xs text-dim" for="vod-part">Taille de part (Mo)</label>
          <input id="vod-part" v-model="part" type="number" min="5" max="64"
            class="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text" />
        </div>
      </div>

      <div class="mt-3 flex gap-1.5">
        <Button id="btn-vod-reglages" variant="primary" size="small" @click="enregistrerStockage">
          Enregistrer
        </Button>
        <!-- Le bouton n'a de sens que si le hub a des clés : sans elles, il n'y
             a rien à éprouver, et le panneau le dit déjà en haut. -->
        <Button
          id="btn-vod-eprouver"
          size="small"
          :disabled="storage?.endpoint == null || controleEnCours"
          @click="eprouver"
        >
          Éprouver la connexion
        </Button>
      </div>

      <div id="vod-controle" class="mt-2">
        <!-- Le contrôle fait quatre allers-retours réseau : sans ce mot, on
             croit que le bouton n'a rien fait et on reclique. -->
        <Hint v-if="controleEnCours" class="mt-0">Contrôle en cours…</Hint>
        <div
          v-else-if="controle != null"
          class="rounded-lg border p-2"
          :class="controle.ok ? 'border-edge' : 'border-alert/40'"
        >
          <div
            class="mb-1 text-[11px] font-semibold tracking-[.08em] uppercase"
            :class="controle.ok ? 'text-dim' : 'text-alert'"
          >
            {{ controle.ok ? 'Stockage joignable et accessible en écriture' : 'Contrôle interrompu' }}
          </div>
          <!-- La dernière étape tentée porte le motif ; les précédentes disent
               jusqu'où on est allé, ce qui est la moitié de l'information. -->
          <div
            v-for="etape in controle.etapes"
            :key="etape.nom"
            class="flex items-baseline gap-2 text-[12px]"
          >
            <span>{{ etape.ok ? '✓' : '✗' }}</span>
            <span :class="etape.ok ? '' : 'text-alert'">
              {{ STORAGE_STEPS[etape.nom] ?? etape.nom }}
            </span>
            <span v-if="etape.detail != null" class="min-w-0 flex-1 break-words text-dim">
              {{ etape.detail }}
            </span>
          </div>
        </div>
      </div>
    </Panel>

    <Panel title="Resynchronisation des salles">
      <label class="mb-[5px] block text-xs text-dim" for="resync-salle">
        Salle à resynchroniser
      </label>
      <select
        id="resync-salle"
        v-model="salleResync"
        class="mb-3 w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text"
      >
        <option value="">Toutes les salles</option>
        <option v-for="salle in rooms" :key="salle.id" :value="salle.id">{{ salle.name }}</option>
      </select>
      <Button id="btn-resync" class="w-full" @click="confirmationResync = true">
        Demander une resynchronisation
      </Button>
    </Panel>

    <ConfirmDialog
      v-model:open="confirmationResync"
      title="Resynchronisation"
      confirm-label="Demander"
      @confirm="confirmerResync"
    >
      <span id="resync-text">
        Demander une resynchronisation complète à
        <strong>{{ nomSalleResync ?? 'toutes les salles' }}</strong>.
      </span>
    </ConfirmDialog>
  </div>
</template>
