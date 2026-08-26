import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session.js'

/**
 * Machines de salle : celles qui demandent à entrer, et celles déjà entrées.
 */
export interface PendingDevice {
  clientId: string
  requestedAt: string
  /** Salle demandée par la machine, transmise sous la forme `room:<id>`. */
  scope?: string | null
}

export interface PairedDevice {
  clientId: string
  roomId: string
  label?: string | null
  revokedAt?: string | null
}

export interface Room {
  id: string
  name: string
}

export interface Verdict {
  status: string
  reason?: string | null
  clientId?: string | null
  roomId?: string | null
}

export const usePairingStore = defineStore('pairing', () => {
  const pending = ref<PendingDevice[]>([])
  const devices = ref<PairedDevice[]>([])
  const rooms = ref<Room[]>([])

  const session = useSessionStore()

  async function load(): Promise<void> {
    const [attente, salles, machines] = await Promise.all([
      session.client.rpc.devices.pending(),
      session.client.rpc.rooms.list(),
      session.client.rpc.devices.list(),
    ])
    pending.value = attente as PendingDevice[]
    rooms.value = salles as Room[]
    devices.value = machines as PairedDevice[]
  }

  async function approve(input: {
    userCode: string
    clientId: string
    roomId: string
  }): Promise<void> {
    await session.client.rpc.devices.approve(input)
    await load()
  }

  async function deny(userCode: string): Promise<void> {
    await session.client.rpc.devices.deny({ userCode })
    await load()
  }

  async function revoke(clientId: string): Promise<void> {
    await session.client.rpc.devices.revoke({ clientId })
    await load()
  }

  async function lookup(userCode: string): Promise<Verdict> {
    return (await session.client.rpc.devices.lookup({ userCode })) as Verdict
  }

  return { pending, devices, rooms, load, approve, deny, revoke, lookup }
})

/**
 * Salle que la machine dit desservir.
 *
 * Pré-sélectionnée mais modifiable : c'est l'opérateur de la salle qui sait où
 * il se trouve, et celui devant la console qui tranche.
 */
export function requestedRoom(device: PendingDevice): string | null {
  const scope = device.scope ?? ''
  return scope.startsWith('room:') ? scope.slice('room:'.length) : null
}

/**
 * Ce qu'un code refusé veut dire, en toutes lettres.
 *
 * Un statut brut ne dit pas quoi faire ensuite, et c'est la seule question que
 * se pose quelqu'un qui tient une machine devant lui.
 */
export const VERDICTS: Record<string, { title: string; body: string }> = {
  inconnu: {
    title: 'Code inconnu',
    body:
      'Aucun appairage en cours ne porte ce code. Vérifiez la saisie — ou la base du hub a été ' +
      'recréée depuis, et la machine doit en demander un nouveau.',
  },
  expire: {
    title: 'Code expiré',
    body:
      "Ce code a dépassé sa durée de vie. La régie en affiche un nouveau dès qu'elle redémarre " +
      'son appairage.',
  },
  approved: {
    title: 'Code déjà approuvé',
    body:
      "Cette machine est appairée : elle figure dans « Machines appairées ». Il n'y a rien à " +
      'faire ici.',
  },
  denied: {
    title: 'Code refusé',
    body:
      "Cet appairage a été refusé. Pour revenir dessus, relancez l'appairage depuis la régie : " +
      'elle affichera un autre code.',
  },
}
