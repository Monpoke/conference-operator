<script setup lang="ts">
import { Badge, Button, Dialog, Empty, Panel, useToast } from '@conference-operator/components'
import { timeAgo } from '@conference-operator/format'
import { storeToRefs } from 'pinia'
import { onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { requestedRoom, VERDICTS, usePairingStore, type PendingDevice } from '../stores/pairing.js'

/**
 * Pairing the room machines.
 *
 * Two paths lead here, and the second is the real one: Better Auth gives the
 * machine the address `/admin/devices?user_code=…`, the operator follows it, and
 * the code must be handled **on the spot**. Sending them to the list behind the
 * modal made them hunt for the right row among others, to redo the gesture they
 * had just checked with their eyes.
 *
 * The code lives in the URL and does not move from it: the route is declared as
 * an alias, and a redirect would erase it on load — that is, at the one moment
 * anybody needs it.
 */
const store = usePairingStore()
const { pending, devices, rooms } = storeToRefs(store)
const toast = useToast()
const route = useRoute()

/** Code saisi et salle choisie, par machine en attente. */
const typed = reactive<Record<string, { code: string; roomId: string }>>({})

function fields(device: PendingDevice): { code: string; roomId: string } {
  typed[device.clientId] ??= {
    code: codeFromUrl.value ?? '',
    roomId: requestedRoom(device) ?? rooms.value[0]?.id ?? '',
  }
  return typed[device.clientId]!
}

function roomName(id: string | null): string | null {
  return rooms.value.find((room) => room.id === id)?.name ?? null
}

const codeFromUrl = ref<string | null>(null)

const verdict = reactive({
  open: false,
  title: 'Code d’appairage',
  body: 'Vérification…',
  error: '',
  clientId: null as string | null,
  roomId: '',
  decidable: false,
  busy: false,
})

/**
 * Qualifies the code on load, deciding nothing.
 *
 * Without a `clientId`, Better Auth has not recognised us as the one consulting
 * the code: approving would fail, so better not to offer it.
 */
async function qualifier(code: string): Promise<void> {
  Object.assign(verdict, {
    open: true,
    title: `Code ${code}`,
    body: 'Vérification…',
    error: '',
    clientId: null,
    decidable: false,
  })
  try {
    const response = await store.lookup(code)
    if (response.status === 'pending' && response.clientId != null) {
      verdict.title = 'Code valide'
      verdict.body = `La machine ${response.clientId} attend son approbation.`
      verdict.clientId = response.clientId
      verdict.roomId = response.roomId ?? rooms.value[0]?.id ?? ''
      verdict.decidable = true
    } else if (response.status === 'pending') {
      verdict.title = 'Code valide'
      verdict.body =
        'Une machine attend, mais ce code a été ouvert par un autre opérateur : son approbation lui revient.'
    } else {
      const said = VERDICTS[response.reason ?? response.status]
      verdict.title = said?.title ?? 'Code illisible'
      verdict.body = said?.body ?? "Le hub n'a pas su qualifier ce code."
    }
  } catch (cause) {
    verdict.title = 'Vérification impossible'
    verdict.body = cause instanceof Error ? cause.message : 'Le hub est injoignable.'
  }
}

async function decider(approuver: boolean): Promise<void> {
  verdict.error = ''
  verdict.busy = true
  try {
    if (approuver) {
      await store.approve({
        userCode: codeFromUrl.value ?? '',
        clientId: verdict.clientId!,
        roomId: verdict.roomId,
      })
      toast.say('Machine appairée')
    } else {
      await store.deny(codeFromUrl.value ?? '')
      toast.say('Appairage refusé')
    }
    verdict.open = false
  } catch (cause) {
    /*
     * In the modal, not in the floating notice: the error is about the gesture one
     * has just made, and refusing a code opened by another operator requires
     * reading a whole sentence.
     */
    verdict.error = cause instanceof Error ? cause.message : 'Le geste a échoué.'
  } finally {
    verdict.busy = false
  }
}

async function approveRequest(device: PendingDevice): Promise<void> {
  const { code, roomId } = fields(device)
  try {
    await store.approve({ userCode: code.trim(), clientId: device.clientId, roomId })
    toast.say('Machine appairée')
  } catch {
    /* already reported */
  }
}

async function refuseRequest(device: PendingDevice): Promise<void> {
  try {
    await store.deny(fields(device).code.trim())
    toast.say('Demande refusée')
  } catch {
    /* already reported */
  }
}

async function revokeMachine(clientId: string): Promise<void> {
  try {
    await store.revoke(clientId)
    toast.say('Machine révoquée')
  } catch {
    /* already reported */
  }
}

onMounted(async () => {
  const code = route.query['user_code']
  codeFromUrl.value = typeof code === 'string' && code !== '' ? code : null
  if (codeFromUrl.value != null) await qualifier(codeFromUrl.value)
})
</script>

<template>
  <div
    id="pairing-view"
    class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] items-start gap-3.5"
  >
    <Panel title="Machines en attente d'appairage">
      <div id="pairings">
        <Empty v-if="pending.length === 0">
          <template v-if="codeFromUrl != null">
            Aucune machine en attente. Le code {{ codeFromUrl }} a peut-être déjà été traité, ou expiré.
          </template>
          <template v-else>Aucune machine en attente.</template>
        </Empty>

        <div
          v-for="device in pending"
          :key="device.clientId"
          class="mb-2.5 rounded-[9px] border border-edge p-3"
          :data-demande="device.clientId"
        >
          <div class="mb-1.5 flex gap-2 text-xs text-dim">
            <span>{{ device.clientId }}</span>
            <span>{{ timeAgo(device.requestedAt) }}</span>
          </div>
          <div v-if="roomName(requestedRoom(device)) != null" class="mb-1.5 text-xs text-dim">
            La machine demande : <strong>{{ roomName(requestedRoom(device)) }}</strong>
          </div>

          <div class="mb-[11px]">
            <label class="mb-[5px] block text-xs text-dim">Code affiché sur la machine</label>
            <input
              v-model="fields(device).code"
              placeholder="XXXX-XXXX"
              class="w-full rounded-lg border bg-canvas px-3 py-2.5 text-sm text-text focus:outline-none"
              :class="codeFromUrl != null ? 'border-brand' : 'border-edge'"
            />
          </div>
          <div class="mb-[11px]">
            <label class="mb-[5px] block text-xs text-dim">Salle desservie</label>
            <select
              v-model="fields(device).roomId"
              class="w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text"
            >
              <option v-for="salle in rooms" :key="salle.id" :value="salle.id">{{ salle.name }}</option>
            </select>
          </div>

          <div class="flex gap-2">
            <Button variant="primary" size="small" @click="approveRequest(device)">Approuver</Button>
            <Button variant="danger" size="small" @click="refuseRequest(device)">Refuser</Button>
          </div>
        </div>
      </div>
    </Panel>

    <Panel title="Machines appairées">
      <div class="overflow-x-auto">
        <table class="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th class="pr-2.5 pb-2 text-left text-[11px] font-semibold tracking-[.08em] text-dim uppercase">
                Machine
              </th>
              <th class="pr-2.5 pb-2 text-left text-[11px] font-semibold tracking-[.08em] text-dim uppercase">
                Salle
              </th>
              <th class="pb-2"></th>
            </tr>
          </thead>
          <tbody id="machines">
            <tr v-if="devices.length === 0">
              <td colspan="3" class="py-3.5 text-[13px] text-dim">Aucune machine appairée.</td>
            </tr>
            <tr v-for="machine in devices" :key="machine.clientId" :data-machine="machine.clientId">
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle">
                {{ machine.label ?? machine.clientId }}
              </td>
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle">{{ machine.roomId }}</td>
              <td class="border-t border-edge py-[9px] align-middle">
                <span v-if="machine.revokedAt != null" class="text-dim">révoquée</span>
                <Button v-else variant="danger" size="small" @click="revokeMachine(machine.clientId)">
                  Révoquer
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>

    <!--
      Le code arrive par l'URL, et se traite sans quitter la page.
    -->
    <Dialog id="verdict-code" v-model:open="verdict.open" :title="verdict.title">
      <div class="text-sm leading-relaxed">
        <div v-if="codeFromUrl != null" class="mb-2 font-semibold tracking-[.12em] tabular-nums">
          {{ codeFromUrl }}
        </div>
        <p id="verdict-text">{{ verdict.body }}</p>
      </div>

      <div v-if="verdict.decidable" id="verdict-decision" class="mt-3.5">
        <label class="mb-[5px] block text-xs text-dim" for="verdict-room">Salle desservie</label>
        <select
          id="verdict-room"
          v-model="verdict.roomId"
          class="w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text"
        >
          <option v-for="salle in rooms" :key="salle.id" :value="salle.id">{{ salle.name }}</option>
        </select>
      </div>

      <p v-if="verdict.error !== ''" id="verdict-error" class="mt-2 text-sm text-alert">
        {{ verdict.error }}
      </p>

      <template #actions>
        <Button
          v-if="verdict.decidable"
          id="verdict-reject"
          variant="danger"
          size="small"
          :disabled="verdict.busy"
          @click="decider(false)"
        >
          Refuser
        </Button>
        <Button
          v-if="verdict.decidable"
          id="verdict-approve"
          variant="primary"
          size="small"
          :disabled="verdict.busy"
          @click="decider(true)"
        >
          Approuver
        </Button>
      </template>
    </Dialog>
  </div>
</template>
