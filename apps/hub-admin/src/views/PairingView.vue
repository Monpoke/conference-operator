<script setup lang="ts">
import { Badge, Button, Dialog, Empty, Panel, useToast } from '@cloudnord/components'
import { timeAgo } from '@cloudnord/format'
import { storeToRefs } from 'pinia'
import { onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { requestedRoom, VERDICTS, usePairingStore, type PendingDevice } from '../stores/pairing.js'

/**
 * Appairage des machines de salle.
 *
 * Deux chemins mènent ici, et le second est le vrai : Better Auth donne à la
 * machine l'adresse `/admin/devices?user_code=…`, l'opérateur la suit, et le
 * code doit être traité **sur place**. Renvoyer vers la liste derrière la
 * modale faisait chercher la bonne ligne parmi d'autres, pour refaire le geste
 * qu'on venait de valider des yeux.
 *
 * Le code vit dans l'URL et n'en bouge pas : la route est déclarée en alias, et
 * une redirection l'effacerait au chargement — c'est-à-dire au seul moment où
 * quelqu'un en a besoin.
 */
const store = usePairingStore()
const { pending, devices, rooms } = storeToRefs(store)
const toast = useToast()
const route = useRoute()

/** Code saisi et salle choisie, par machine en attente. */
const saisie = reactive<Record<string, { code: string; roomId: string }>>({})

function champs(device: PendingDevice): { code: string; roomId: string } {
  saisie[device.clientId] ??= {
    code: codeDeLUrl.value ?? '',
    roomId: requestedRoom(device) ?? rooms.value[0]?.id ?? '',
  }
  return saisie[device.clientId]!
}

function nomDeSalle(id: string | null): string | null {
  return rooms.value.find((salle) => salle.id === id)?.name ?? null
}

const codeDeLUrl = ref<string | null>(null)

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
 * Qualifie le code au chargement, sans rien décider.
 *
 * Sans `clientId`, Better Auth ne nous a pas reconnus comme le consultant du
 * code : approuver échouerait, autant ne pas le proposer.
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
    const reponse = await store.lookup(code)
    if (reponse.status === 'pending' && reponse.clientId != null) {
      verdict.title = 'Code valide'
      verdict.body = `La machine ${reponse.clientId} attend son approbation.`
      verdict.clientId = reponse.clientId
      verdict.roomId = reponse.roomId ?? rooms.value[0]?.id ?? ''
      verdict.decidable = true
    } else if (reponse.status === 'pending') {
      verdict.title = 'Code valide'
      verdict.body =
        'Une machine attend, mais ce code a été ouvert par un autre opérateur : son approbation lui revient.'
    } else {
      const dit = VERDICTS[reponse.reason ?? reponse.status]
      verdict.title = dit?.title ?? 'Code illisible'
      verdict.body = dit?.body ?? "Le hub n'a pas su qualifier ce code."
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
        userCode: codeDeLUrl.value ?? '',
        clientId: verdict.clientId!,
        roomId: verdict.roomId,
      })
      toast.say('Machine appairée')
    } else {
      await store.deny(codeDeLUrl.value ?? '')
      toast.say('Appairage refusé')
    }
    verdict.open = false
  } catch (cause) {
    /*
     * Dans la modale, pas dans l'avis flottant : l'erreur porte sur le geste
     * qu'on vient de faire, et le refus d'un code ouvert par un autre opérateur
     * demande de lire une phrase entière.
     */
    verdict.error = cause instanceof Error ? cause.message : 'Le geste a échoué.'
  } finally {
    verdict.busy = false
  }
}

async function approuverDemande(device: PendingDevice): Promise<void> {
  const { code, roomId } = champs(device)
  try {
    await store.approve({ userCode: code.trim(), clientId: device.clientId, roomId })
    toast.say('Machine appairée')
  } catch {
    /* déjà remonté */
  }
}

async function refuserDemande(device: PendingDevice): Promise<void> {
  try {
    await store.deny(champs(device).code.trim())
    toast.say('Demande refusée')
  } catch {
    /* déjà remonté */
  }
}

async function revoquer(clientId: string): Promise<void> {
  try {
    await store.revoke(clientId)
    toast.say('Machine révoquée')
  } catch {
    /* déjà remonté */
  }
}

onMounted(async () => {
  const code = route.query['user_code']
  codeDeLUrl.value = typeof code === 'string' && code !== '' ? code : null
  if (codeDeLUrl.value != null) await qualifier(codeDeLUrl.value)
})
</script>

<template>
  <div
    id="vue-appairage"
    class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] items-start gap-3.5"
  >
    <Panel title="Machines en attente d'appairage">
      <div id="appairages">
        <Empty v-if="pending.length === 0">
          <template v-if="codeDeLUrl != null">
            Aucune machine en attente. Le code {{ codeDeLUrl }} a peut-être déjà été traité, ou expiré.
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
          <div v-if="nomDeSalle(requestedRoom(device)) != null" class="mb-1.5 text-xs text-dim">
            La machine demande : <strong>{{ nomDeSalle(requestedRoom(device)) }}</strong>
          </div>

          <div class="mb-[11px]">
            <label class="mb-[5px] block text-xs text-dim">Code affiché sur la machine</label>
            <input
              v-model="champs(device).code"
              placeholder="XXXX-XXXX"
              class="w-full rounded-lg border bg-canvas px-3 py-2.5 text-sm text-text focus:outline-none"
              :class="codeDeLUrl != null ? 'border-brand' : 'border-edge'"
            />
          </div>
          <div class="mb-[11px]">
            <label class="mb-[5px] block text-xs text-dim">Salle desservie</label>
            <select
              v-model="champs(device).roomId"
              class="w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text"
            >
              <option v-for="salle in rooms" :key="salle.id" :value="salle.id">{{ salle.name }}</option>
            </select>
          </div>

          <div class="flex gap-2">
            <Button variant="primary" size="small" @click="approuverDemande(device)">Approuver</Button>
            <Button variant="danger" size="small" @click="refuserDemande(device)">Refuser</Button>
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
                <Button v-else variant="danger" size="small" @click="revoquer(machine.clientId)">
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
        <div v-if="codeDeLUrl != null" class="mb-2 font-semibold tracking-[.12em] tabular-nums">
          {{ codeDeLUrl }}
        </div>
        <p id="verdict-text">{{ verdict.body }}</p>
      </div>

      <div v-if="verdict.decidable" id="verdict-decision" class="mt-3.5">
        <label class="mb-[5px] block text-xs text-dim" for="verdict-salle">Salle desservie</label>
        <select
          id="verdict-salle"
          v-model="verdict.roomId"
          class="w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text"
        >
          <option v-for="salle in rooms" :key="salle.id" :value="salle.id">{{ salle.name }}</option>
        </select>
      </div>

      <p v-if="verdict.error !== ''" id="verdict-erreur" class="mt-2 text-sm text-alert">
        {{ verdict.error }}
      </p>

      <template #actions>
        <Button
          v-if="verdict.decidable"
          id="verdict-refuser"
          variant="danger"
          size="small"
          :disabled="verdict.busy"
          @click="decider(false)"
        >
          Refuser
        </Button>
        <Button
          v-if="verdict.decidable"
          id="verdict-approuver"
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
