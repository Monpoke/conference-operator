<script setup lang="ts">
import { Button, Hint, Panel, useToast } from '@conference-operator/components'
import { AUDIT_RETENTION_DAYS } from '@conference-operator/contract'
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { PAGE_SIZE, actionLabel, resultOf, toCsv, useAuditStore } from '../stores/audit.js'

/**
 * The audit log: who did what through the hub.
 *
 * Every write — a phone's gesture, a setting, a device, an account — with the
 * hub's answer, and the room's when a command was sent to one. Read after the
 * fact: a scene that switched with nobody at the console, a setting nobody
 * remembers changing.
 */
const store = useAuditStore()
const { entries, total, page, rooms, room, actor, actors } = storeToRefs(store)
const toast = useToast()
const exporting = ref(false)

const roomOptions = computed(() => [
  { value: '', label: 'Toutes les salles' },
  ...rooms.value.map((room) => ({ value: room.id, label: room.name })),
])
const actorOptions = computed(() => [
  { value: '', label: 'Tout le monde' },
  ...actors.value.map((email) => ({ value: email, label: email })),
])

watch([room, actor], () => void store.reload().catch(() => {}))

// The search leaves once typing pauses, not on every key.
const search = ref(store.query)
let typing: ReturnType<typeof setTimeout> | null = null
watch(search, (q) => {
  if (typing != null) clearTimeout(typing)
  typing = setTimeout(() => void store.search(q).catch(() => {}), 300)
})
onBeforeUnmount(() => {
  if (typing != null) clearTimeout(typing)
})

const pages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const filtered = computed(() => search.value.trim() !== '' || room.value !== '' || actor.value !== '')

const roomName = (id: string) => rooms.value.find((room) => room.id === id)?.name ?? id

/** Re-read on every poll, so "Envoyé à la salle…" turns into its silence. */
const now = computed(() => (entries.value, Date.now()))

const DATE = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'medium' })

async function exportCsv(): Promise<void> {
  exporting.value = true
  try {
    const all = await store.everything()
    const blob = new Blob([toCsv(all, roomName, Date.now())], { type: 'text/csv;charset=utf-8' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `journal-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(link.href)
    toast.say(`${all.length} entrée${all.length > 1 ? 's' : ''} exportée${all.length > 1 ? 's' : ''}`)
  } catch {
    /* already reported by the client's error hook */
  } finally {
    exporting.value = false
  }
}

async function goTo(next: number): Promise<void> {
  try {
    await store.goTo(next)
    document.getElementById('journal-view')?.scrollIntoView?.({ block: 'start' })
  } catch {
    /* already reported by the client's error hook */
  }
}

const FILTER = 'min-w-[150px] flex-1 rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text'
const CELL = 'border-t border-edge py-[9px] pr-2.5 align-top'
</script>

<template>
  <div id="journal-view">
    <Panel title="Journal">
      <div class="mb-2 flex flex-wrap gap-1.5">
        <select id="journal-room" v-model="room" :class="FILTER">
          <option v-for="option in roomOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
        <select id="journal-actor" v-model="actor" :class="FILTER">
          <option v-for="option in actorOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
        <input
          id="journal-search"
          v-model="search"
          type="search"
          maxlength="100"
          placeholder="Rechercher : action, personne, détail…"
          aria-label="Rechercher dans le journal"
          :class="FILTER"
        />
        <Button id="btn-journal-export" size="small" :disabled="exporting" @click="exportCsv">
          Exporter en CSV
        </Button>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full border-collapse text-[13px]">
          <thead>
            <tr class="text-[11px] tracking-[.08em] text-dim uppercase">
              <th class="pr-2.5 pb-2 text-left font-semibold">Quand</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">Qui</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">Action</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">Salle</th>
              <th class="pb-2 text-left font-semibold">Résultat</th>
            </tr>
          </thead>
          <tbody id="journal-rows">
            <tr v-if="entries.length === 0">
              <td colspan="5" class="py-3.5 text-dim">
                {{ filtered ? 'Aucune action ne correspond.' : 'Aucune action enregistrée.' }}
              </td>
            </tr>
            <tr v-for="entry in entries" :key="entry.id" :data-entry="entry.id">
              <td :class="CELL" class="whitespace-nowrap tabular-nums">{{ DATE.format(new Date(entry.at)) }}</td>
              <td :class="CELL">{{ entry.actor }}</td>
              <td :class="CELL">
                {{ actionLabel(entry) }}
                <!-- The request itself, for whoever needs more than the words. -->
                <details v-if="entry.detail != null" class="text-[11px] text-dim">
                  <summary class="cursor-pointer">détail</summary>
                  <code class="font-mono break-all">{{ entry.detail }}</code>
                </details>
              </td>
              <td :class="CELL">{{ entry.roomId == null ? '—' : roomName(entry.roomId) }}</td>
              <td :class="[CELL, resultOf(entry, now).tone]" data-role="result">
                {{ resultOf(entry, now).label }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <nav
        v-if="pages > 1"
        id="journal-pages"
        class="mt-2 flex items-center justify-between gap-2"
        aria-label="Pages du journal"
      >
        <Button size="small" data-role="previous" :disabled="page <= 1" @click="goTo(page - 1)">
          Plus récent
        </Button>
        <span class="text-center text-xs text-dim">Page {{ page }} sur {{ pages }} · {{ total }} entrées</span>
        <Button size="small" data-role="next" :disabled="page >= pages" @click="goTo(page + 1)">
          Plus ancien
        </Button>
      </nav>

      <Hint id="journal-hint">
        Toutes les actions qui modifient quelque chose via le hub — régie mobile, réglages, postes,
        comptes — avec la réponse de la salle quand une commande lui a été envoyée. Les entrées de
        plus de {{ AUDIT_RETENTION_DAYS }} jours sont effacées.
      </Hint>
    </Panel>
  </div>
</template>
