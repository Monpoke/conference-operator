<script setup lang="ts">
import { Button, Hint, Panel, useToast } from '@conference-operator/components'
import { storeToRefs } from 'pinia'
import { computed, watch } from 'vue'
import { UPLOAD_STATES, progress, useVodStore, type Upload } from '../stores/vod.js'

/**
 * Uploads of the takes.
 *
 * The console's only view that is looked at at a precise moment of the day: just
 * before dismantling a room, while its disk is still plugged in.
 */
const store = useVodStore()
const { uploads, rooms, room } = storeToRefs(store)
const toast = useToast()

const roomOptions = computed(() => [
  { value: '', label: 'Toutes les roomOptions' },
  ...rooms.value.map((room) => ({ value: room.id, label: room.name })),
])

watch(room, () => void store.load())

function stateOf(upload: Upload): { label: string; tone: string } {
  return UPLOAD_STATES[upload.state] ?? { label: upload.state, tone: '' }
}

/** The current rate, in kB/s — the unit in which one judges whether it is moving. */
function rate(upload: Upload): string {
  return upload.debitOctetsS == null ? '' : ` · ${Math.round(upload.debitOctetsS / 1024)} Ko/s`
}

async function requestUpload(roomId: string, file: string | null): Promise<void> {
  try {
    await store.request(roomId, file)
    toast.say(file == null ? 'Rapatriement demandé' : 'Relance demandée')
  } catch {
    /* already reported by the client's error hook */
  }
}

function requestAll(): void {
  if (room.value === '') {
    // The request goes to one specific machine: with no room there would be nobody
    // to talk to. Saying so beats a button that does nothing.
    toast.fail('Choisissez une salle : la demande part vers une machine précise.')
    return
  }
  void requestUpload(room.value, null)
}
</script>

<template>
  <div
    id="vod-view"
    class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] items-start gap-3.5"
  >
    <Panel title="Téléversements">
      <div class="mb-2 flex flex-wrap gap-1.5">
        <select
          id="vod-room"
          v-model="room"
          class="min-w-[150px] flex-1 rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text"
        >
          <option v-for="room in roomOptions" :key="room.value" :value="room.value">
            {{ room.label }}
          </option>
        </select>
        <Button id="btn-vod-retry" size="small" @click="requestAll">Tout relancer</Button>
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
          <tbody id="vod-rows">
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
                :class="stateOf(upload).tone"
              >
                {{ stateOf(upload).label }}
              </td>
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle">
                {{ progress(upload) }} %{{ rate(upload) }}
              </td>
              <td class="border-t border-edge py-[9px] align-middle">
                <Button
                  v-if="upload.state !== 'termine'"
                  size="small"
                  @click="requestUpload(upload.roomId, upload.file)"
                >
                  Relancer
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <Hint id="vod-hint">
        À regarder <strong>avant de démonter une salle</strong> : c'est le dernier
        moment où son disque est encore branché. Un rush qui n'est pas ici n'est
        nulle part ailleurs qu'à Lille.
      </Hint>
    </Panel>
  </div>
</template>
