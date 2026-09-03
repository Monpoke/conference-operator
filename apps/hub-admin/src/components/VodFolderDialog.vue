<script setup lang="ts">
import { Button, Dialog, Hint, useToast } from '@cloudnord/components'
import { time } from '@cloudnord/format'
import { ref, watch } from 'vue'
import { UPLOAD_STATES, progress, type Upload } from '../stores/vod.js'
import { useConferencesStore, type PlannedSession } from '../stores/conferences.js'

/**
 * Où en est la captation d'une conférence.
 *
 * Deux moitiés qui ne disent pas la même chose : ce que la **régie** a
 * enregistré, et ce que le **stockage** a reçu. Confondre les deux fait croire
 * qu'un rush est en sécurité parce qu'il existe sur un disque à Lille.
 */
interface Capture {
  obs: string
  startedAt: string
  endedAt?: string | null
  durationMs?: number | null
  file?: string | null
  enCours: boolean
  finInconnue: boolean
  sidecarWritten: boolean
  rattachement?: string | null
}

interface Folder {
  roomId: string | null
  roomName?: string | null
  captations: Capture[]
  televersements: (Upload & { kind: string; objectKey: string })[]
  stockageConfigure: boolean
}

const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ session: PlannedSession | null; timezone: string }>()

const store = useConferencesStore()
const toast = useToast()

const folder = ref<Folder | null>(null)
const erreur = ref('')
const chargement = ref(false)

watch(
  () => [open.value, props.session?.id] as const,
  async ([ouvert, id]) => {
    if (!ouvert || id == null) return
    folder.value = null
    erreur.value = ''
    chargement.value = true
    try {
      const reponse = (await store.vodFolder(id)) as Folder
      /*
       * Une réponse qui arrive après qu'on a refermé, ou après avoir ouvert
       * une autre conférence, ne doit pas repeindre la modale par-dessus.
       */
      if (!open.value || props.session?.id !== id) return
      folder.value = reponse
    } catch (cause) {
      if (!open.value || props.session?.id !== id) return
      erreur.value = cause instanceof Error ? cause.message : 'Lecture impossible.'
    } finally {
      chargement.value = false
    }
  },
  { immediate: true },
)

/**
 * Quatre états, pas trois.
 *
 * « Interrompue » se distingue de « en cours » : le hub n'a jamais entendu son
 * arrêt et ne l'entendra plus, une autre prise ayant démarré derrière. Les
 * confondre empilait des enregistrements prétendument actifs sur une salle qui
 * n'enregistrait rien.
 */
function etatPrise(prise: Capture): { texte: string; tone: string } {
  if (prise.finInconnue) return { texte: 'interrompue, fin jamais reçue', tone: 'text-attention' }
  if (prise.enCours) return { texte: 'enregistrement en cours', tone: 'text-marque' }
  if (prise.file == null) return { texte: 'arrêtée sans fichier', tone: 'text-alerte' }
  return { texte: 'fichier écrit', tone: 'text-ok' }
}

/**
 * L'intervalle de la prise, dans le fuseau de l'événement.
 *
 * Un intervalle qui se termine avant de commencer n'est pas affiché : les
 * instants viennent de l'horloge de la salle, qui peut être **simulée** et
 * sauter d'un événement à l'autre. « 09:00–08:36 » ne décrit rien et fait
 * douter du reste de la ligne — alors que la durée, mesurée par la salle,
 * reste juste. On garde donc le début seul.
 */
function quand(prise: Capture): string {
  const debut = time(prise.startedAt, props.timezone)
  if (prise.endedAt == null) return `${debut}–…`
  const coherent = Date.parse(prise.endedAt) >= Date.parse(prise.startedAt)
  return coherent ? `${debut}–${time(prise.endedAt, props.timezone)}` : debut
}

/** Un rush disponible en salle mais rien de monté : il y a quelque chose à faire. */
function rushDisponible(dossier: Folder): boolean {
  return dossier.captations.some((prise) => !prise.enCours && prise.file != null)
}

async function rapatrier(roomId: string, file: string | null): Promise<void> {
  try {
    await store.requestVod(roomId, file)
    toast.say(file == null ? 'Rapatriement demandé' : 'Relance demandée')
  } catch {
    /* déjà remonté par le crochet d'erreur du client */
  }
}

function etatMontee(ligne: Upload): { label: string; tone: string } {
  return UPLOAD_STATES[ligne.state] ?? { label: ligne.state, tone: '' }
}
</script>

<template>
  <Dialog v-model:open="open" :title="session?.title ?? 'Captation'" width="wide">
    <p class="text-xs text-attenue">
      {{ session?.roomName ?? 'salle inconnue'
      }}{{ session != null && session.speakers.length > 0 ? ` · ${session.speakers.join(', ')}` : '' }}
    </p>

    <div id="vod-corps" class="mt-3">
      <p v-if="chargement" class="text-attenue">Lecture…</p>
      <p v-else-if="erreur !== ''" class="text-alerte">{{ erreur }}</p>

      <template v-else-if="folder != null">
        <h3 class="mb-2.5 text-[11px] font-semibold tracking-[.14em] text-attenue uppercase">
          Sur la régie
        </h3>

        <Hint v-if="folder.roomId == null">
          Ce créneau n'est rattaché à aucune salle dans l'export : aucune régie n'avait à
          l'enregistrer.
        </Hint>

        <template v-else-if="folder.captations.length === 0">
          <p class="text-attention">
            Aucune prise remontée par {{ folder.roomName ?? folder.roomId }}.
          </p>
          <Hint>
            Le hub ne lit pas le disque de la régie : il recompose les prises depuis ce que la
            salle remonte en démarrant et en arrêtant OBS. Rien ici veut dire qu'aucun
            enregistrement n'a été signalé sur ce créneau — pas qu'il n'y a rien sur le disque.
            À vérifier en régie avant de démonter la salle.
          </Hint>
        </template>

        <div
          v-for="(prise, index) in folder.captations"
          v-else
          :key="`${prise.obs}-${prise.startedAt}-${index}`"
          class="border-t border-bord py-2 first:border-t-0"
          data-prise
        >
          <div class="text-sm">
            <span :class="etatPrise(prise).tone">{{ etatPrise(prise).texte }}</span>
            · OBS {{ prise.obs }}
            <template v-if="prise.durationMs != null">
              · {{ Math.round(prise.durationMs / 60000) }} min
            </template>
            <!--
              Le sidecar n'est pas un détail : sans lui le rush arrive au editing
              sans titre, sans intervenants et sans marqueurs.
            -->
            <template v-if="!prise.enCours && !prise.finInconnue">
              <template v-if="prise.sidecarWritten"> · sidecar écrit</template>
              <span v-else class="text-attention"> · sans sidecar</span>
            </template>
          </div>
          <div class="text-[11px] tabular-nums text-attenue">{{ quand(prise) }}</div>
          <div v-if="prise.file != null" class="font-mono text-[11px] break-all">
            {{ prise.file }}
          </div>
          <div v-else class="text-[11px] text-alerte">
            OBS n'a rendu aucun chemin — disque plein, ou processus tué en plein arrêt.
          </div>
          <!-- Un rattachement déduit de l'heure est une piste, pas un fait. -->
          <div v-if="prise.rattachement === 'horaire'" class="text-[11px] text-attention">
            Rattachée à l'heure : la prise ne porte aucun créneau, mais elle recouvre celui-ci
            dans la même salle.
          </div>
        </div>

        <h3 class="mt-3.5 mb-2.5 text-[11px] font-semibold tracking-[.14em] text-attenue uppercase">
          Chez le stockage
        </h3>

        <Hint v-if="!folder.stockageConfigure">
          Aucun stockage configuré sur ce hub : rien ne peut partir, et « rien de monté » ne veut
          donc rien dire ici. Le stockage se règle dans
          <strong>Réglages → Rapatriement des rushes</strong>.
        </Hint>

        <template v-else-if="folder.televersements.length === 0">
          <p :class="rushDisponible(folder) ? 'text-attention' : 'text-attenue'">
            Rien de monté pour cette conférence.
          </p>
          <Button
            v-if="rushDisponible(folder) && folder.roomId != null"
            size="small"
            class="mt-1.5"
            @click="rapatrier(folder.roomId, null)"
          >
            Rapatrier cette salle
          </Button>
        </template>

        <div
          v-for="ligne in folder.televersements"
          v-else
          :key="ligne.objectKey"
          class="border-t border-bord py-2 first:border-t-0"
          data-montee
        >
          <div class="text-sm">
            <span :class="etatMontee(ligne).tone">{{ etatMontee(ligne).label }}</span>
            · {{ ligne.kind }} · {{ progress(ligne) }} %
          </div>
          <!--
            La clé d'objet, pas seulement le nom du fichier : c'est elle qu'on
            donne à qui va chercher le rush dans le bucket.
          -->
          <div class="font-mono text-[11px] break-all">{{ ligne.objectKey }}</div>
          <div v-if="ligne.lastError != null" class="text-[11px] text-alerte">
            {{ ligne.lastError }}
          </div>
          <Button
            v-if="ligne.state !== 'termine'"
            size="small"
            class="mt-1.5"
            @click="rapatrier(ligne.roomId, ligne.file)"
          >
            Relancer
          </Button>
        </div>
      </template>
    </div>
  </Dialog>
</template>
