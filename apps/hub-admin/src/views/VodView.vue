<script setup lang="ts">
import { Button, Hint, Panel, useToast } from '@cloudnord/components'
import { storeToRefs } from 'pinia'
import { computed, watch } from 'vue'
import { UPLOAD_STATES, progress, useVodStore, type Upload } from '../stores/vod.js'

/**
 * Téléversements des captations.
 *
 * La seule vue de la console qui se regarde à un moment précis de la journée :
 * juste avant de démonter une salle, quand son disque est encore branché.
 */
const store = useVodStore()
const { uploads, rooms, room } = storeToRefs(store)
const toast = useToast()

const salles = computed(() => [
  { value: '', label: 'Toutes les salles' },
  ...rooms.value.map((salle) => ({ value: salle.id, label: salle.name })),
])

watch(room, () => void store.load())

function etat(upload: Upload): { label: string; tone: string } {
  return UPLOAD_STATES[upload.state] ?? { label: upload.state, tone: '' }
}

/** Débit courant, en Ko/s — l'unité dans laquelle on juge si ça avance. */
function debit(upload: Upload): string {
  return upload.debitOctetsS == null ? '' : ` · ${Math.round(upload.debitOctetsS / 1024)} Ko/s`
}

async function relancer(roomId: string, file: string | null): Promise<void> {
  try {
    await store.request(roomId, file)
    toast.say(file == null ? 'Rapatriement demandé' : 'Relance demandée')
  } catch {
    /* déjà remonté par le crochet d'erreur du client */
  }
}

function relancerTout(): void {
  if (room.value === '') {
    // La demande part vers une machine précise : sans salle, on ne saurait pas
    // à qui parler. Le dire vaut mieux qu'un bouton qui ne fait rien.
    toast.fail('Choisissez une salle : la demande part vers une machine précise.')
    return
  }
  void relancer(room.value, null)
}
</script>

<template>
  <div
    id="vue-vod"
    class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] items-start gap-3.5"
  >
    <Panel title="Téléversements">
      <div class="mb-2 flex flex-wrap gap-1.5">
        <select
          id="vod-salle"
          v-model="room"
          class="min-w-[150px] flex-1 rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text"
        >
          <option v-for="salle in salles" :key="salle.value" :value="salle.value">
            {{ salle.label }}
          </option>
        </select>
        <Button id="btn-vod-relancer" size="small" @click="relancerTout">Tout relancer</Button>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full border-collapse text-[13px]">
          <thead>
            <tr class="text-[11px] tracking-[.08em] text-dim uppercase">
              <th class="pr-2.5 pb-2 text-left font-semibold">Salle</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">Fichier</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">État</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">Avancement</th>
              <th class="pb-2"></th>
            </tr>
          </thead>
          <tbody id="vod-lignes">
            <tr v-if="uploads.length === 0">
              <td colspan="5" class="py-3.5 text-dim">Aucun téléversement.</td>
            </tr>
            <tr
              v-for="upload in uploads"
              :key="`${upload.roomId}/${upload.file}`"
              :data-upload="upload.file"
            >
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle">
                {{ upload.roomName ?? upload.roomId }}
              </td>
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle font-mono text-[11px]">
                {{ upload.file }}
                <!--
                  L'erreur du stockage est reprise telle quelle : « AccessDenied »
                  est le seul mot qu'on puisse porter à qui tient le bucket.
                -->
                <div v-if="upload.lastError != null" class="text-[11px] text-alert">
                  {{ upload.lastError }}
                </div>
              </td>
              <td
                class="border-t border-edge py-[9px] pr-2.5 align-middle"
                :class="etat(upload).tone"
              >
                {{ etat(upload).label }}
              </td>
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle">
                {{ progress(upload) }} %{{ debit(upload) }}
              </td>
              <td class="border-t border-edge py-[9px] align-middle">
                <Button
                  v-if="upload.state !== 'termine'"
                  size="small"
                  @click="relancer(upload.roomId, upload.file)"
                >
                  Relancer
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <Hint id="vod-aide">
        À regarder <strong>avant de démonter une salle</strong> : c'est le dernier
        moment où son disque est encore branché. Un rush qui n'est pas ici n'est
        nulle part ailleurs qu'à Lille.
      </Hint>
    </Panel>
  </div>
</template>
