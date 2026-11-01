import type { PartageVideo } from '@conference-operator/contract'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session.js'

/** Without the look-alikes: read aloud or copied by hand, it must not be misread. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

export function genererMotDePasse(): string {
  return [...crypto.getRandomValues(new Uint8Array(14))].map((byte) => ALPHABET[byte % ALPHABET.length]).join('')
}

export const usePartagesStore = defineStore('partages', () => {
  const session = useSessionStore()
  const partages = ref<PartageVideo[]>([])

  async function load(): Promise<void> {
    partages.value = await session.client.rpc.partages.list()
  }
  async function create(sessionId: string | null, motDePasse: string): Promise<void> {
    await session.client.rpc.partages.create({ sessionId, motDePasse })
    await load()
  }
  async function remove(id: string): Promise<void> {
    await session.client.rpc.partages.remove({ id })
    await load()
  }

  return { partages, load, create, remove }
})
