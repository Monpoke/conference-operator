<script setup lang="ts">
import { Button, Empty, Hint, Panel, useToast } from '@conference-operator/components'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useSeededField } from '../../composables/seededField.js'
import { checkSocialLinks, type SocialField, type SocialRowError } from '../../composables/socialLinks.js'
import { orNull, useSettingsStore, type SocialLink } from '../../stores/settings.js'

/**
 * Réglages, Événement: its name, its program, its accounts, how a talk closes.
 *
 * Mounted with its siblings and only hidden: a draft survives a change of section.
 */
const store = useSettingsStore()
const { settings, derived, snapshots, images } = storeToRefs(store)
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

/** What is wrong with each row, by index — cleared as soon as the row is edited. */
const socialErrors = ref<Record<number, SocialRowError>>({})

watch(socialLinks, () => {
  socialErrors.value = {}
}, { deep: true })

function socialInvalid(index: number, field: SocialField): boolean {
  return socialErrors.value[index]?.fields.includes(field) === true
}

async function saveSocialLinks(): Promise<void> {
  // Checked here, not left to the hub: see `checkSocialLinks`. An empty row is
  // dropped, a half-filled one stops the save with what is missing.
  const { links, errors } = checkSocialLinks(socialLinks.value)
  if (Object.keys(errors).length > 0) {
    socialErrors.value = errors
    const count = Object.keys(errors).length
    toast.fail(`Rien n'est enregistré : ${count} compte${count > 1 ? 's' : ''} à corriger.`)
    return
  }
  try {
    await store.update({ socialLinks: links })
    // What was stored, as stored: `cloudnord.fr` now reads `https://cloudnord.fr/`.
    socialLinks.value = links.map((link) => ({ ...link }))
    toast.say(links.length === 0 ? 'Réseaux enregistrés : aucun compte' : `Réseaux enregistrés : ${links.length} compte${links.length > 1 ? 's' : ''}`)
  } catch {
    /* already reported by the client's error hook — and nothing is said to have been saved */
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
</script>

<template>
  <div class="flex flex-col gap-3.5">
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
      <Button id="btn-event" variant="primary" size="small" class="self-start" @click="saveEvent">
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
        <!--
          Under 768 px a version is a card, as on the Conferences page; the
          figures carry their word, the column headers being gone.
        -->
        <table class="w-full border-collapse text-[13px] max-md:block">
          <thead class="max-md:hidden">
            <tr class="text-[11px] tracking-[.08em] text-dim uppercase">
              <th class="pr-2.5 pb-2 text-left font-semibold">Version</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">Créneaux</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">Anomalies</th>
              <th class="pb-2"></th>
            </tr>
          </thead>
          <tbody id="snapshots" class="max-md:block">
            <tr v-if="snapshots.length === 0" class="max-md:block">
              <td colspan="4" class="max-md:block"><Empty>Aucun programme importé.</Empty></td>
            </tr>
            <tr
              v-for="snapshot in snapshots"
              v-else
              :key="snapshot.contentHash"
              :data-snapshot="snapshot.contentHash"
              class="max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-2.5 max-md:gap-y-1 max-md:border-t max-md:border-edge max-md:py-2.5"
            >
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle max-md:border-t-0 max-md:py-0 max-md:pr-0 font-mono text-[11px] max-md:basis-full">
                <span v-if="snapshot.active" class="text-ok">● actif </span>
                {{ snapshot.contentHash.slice(0, 10) }}
              </td>
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle max-md:border-t-0 max-md:py-0 max-md:pr-0">
                {{ snapshot.sessionCount }}<span class="md:hidden"> créneaux</span>
              </td>
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle max-md:border-t-0 max-md:py-0 max-md:pr-0 max-md:flex-1" :class="{ 'max-md:text-dim': snapshot.issueCount === 0 }">
                <span class="max-md:hidden">{{ snapshot.issueCount > 0 ? snapshot.issueCount : '—' }}</span>
                <span class="md:hidden">
                  {{ snapshot.issueCount > 0 ? `${snapshot.issueCount} anomalie${snapshot.issueCount > 1 ? 's' : ''}` : 'aucune anomalie' }}
                </span>
              </td>
              <td class="border-t border-edge py-[9px] align-middle max-md:border-t-0 max-md:py-0">
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

      <!--
        Les images, et ce qui manque.

        Les salles ne vont plus les chercher chez la source : elles les prennent
        sur le hub. Une image que le hub n'a pas obtenue manque donc sur tous les
        écrans à la fois — et c'est d'ici qu'on corrige l'export, pas depuis le
        journal de trois salles.
      -->
      <div class="mt-4 border-t border-edge pt-3.5" id="program-images">
        <h3 class="mb-1.5 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
          Images
        </h3>
        <p class="text-[13px] text-dim">
          {{ images.held }} image{{ images.held > 1 ? 's' : '' }} servie{{
            images.held > 1 ? 's' : ''
          }}
          aux salles depuis ce hub.
        </p>
        <ul v-if="images.failed.length > 0" class="mt-2 flex flex-col gap-1">
          <li
            v-for="failure in images.failed"
            :key="failure.url"
            class="text-[13px] text-alert"
            data-role="image-failure"
          >
            {{ failure.reason }} — <span class="break-all opacity-80">{{ failure.url }}</span>
          </li>
        </ul>
        <p v-else class="mt-1 text-[13px] text-dim">
          Aucune image manquante. Une salle n'a donc rien à aller chercher sur Internet.
        </p>
      </div>
    </Panel>

    <Panel title="Nos réseaux">
      <div id="socials">
        <Empty v-if="socialLinks.length === 0">
          Aucun compte déclaré. La boucle des salles saute cette page.
        </Empty>
        <div v-for="(link, index) in socialLinks" :key="index" class="mb-1.5" :data-social-row="index">
          <div
            class="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,2fr)_auto] items-center gap-1.5 max-md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
          >
            <input
              v-model="link.network"
              placeholder="Réseau"
              :aria-invalid="socialInvalid(index, 'network')"
              class="min-w-0 rounded-lg border bg-canvas px-2 py-1.5 text-sm text-text"
              :class="socialInvalid(index, 'network') ? 'border-alert' : 'border-edge'"
            />
            <input
              v-model="link.handle"
              placeholder="@handle"
              :aria-invalid="socialInvalid(index, 'handle')"
              class="min-w-0 rounded-lg border bg-canvas px-2 py-1.5 text-sm text-text"
              :class="socialInvalid(index, 'handle') ? 'border-alert' : 'border-edge'"
            />
            <input
              v-model="link.url"
              placeholder="https://…"
              :aria-invalid="socialInvalid(index, 'url')"
              class="min-w-0 rounded-lg border bg-canvas px-2 py-1.5 text-sm text-text max-md:order-last max-md:col-span-3"
              :class="socialInvalid(index, 'url') ? 'border-alert' : 'border-edge'"
            />
            <Button variant="danger" size="small" title="Retirer ce compte" @click="socialLinks.splice(index, 1)">
              ×
            </Button>
          </div>
          <p v-if="socialErrors[index]" class="mt-1 text-xs text-alert" :data-social-error="index">
            {{ socialErrors[index]!.message }}
          </p>
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
      <Button id="btn-auto-end" variant="primary" size="small" class="mt-3 self-start" @click="saveAutoEnd">
        Enregistrer
      </Button>
    </Panel>
  </div>
</template>
