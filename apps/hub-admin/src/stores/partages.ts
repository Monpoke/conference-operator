import type { PartageVideo } from '@conference-operator/contract'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session.js'

/** Without the look-alikes: read aloud or copied by hand, it must not be misread. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

export function genererMotDePasse(): string {
  return [...crypto.getRandomValues(new Uint8Array(14))].map((byte) => ALPHABET[byte % ALPHABET.length]).join('')
}

export function lienAvecMotDePasse(url: string, motDePasse: string): string {
  return `${url}?mdp=${encodeURIComponent(motDePasse)}`
}

export const usePartagesStore = defineStore('partages', () => {
  const session = useSessionStore()
  const partages = ref<PartageVideo[]>([])

  async function load(): Promise<void> {
    partages.value = await session.client.rpc.partages.list()
  }
  /** Resolves to the link holding the password: the hub does not keep it, so this is the only time. */
  async function create(sessionId: string | null, motDePasse: string): Promise<string> {
    const { url } = await session.client.rpc.partages.create({ sessionId, motDePasse })
    await load()
    return lienAvecMotDePasse(url, motDePasse)
  }
  async function remove(id: string): Promise<void> {
    await session.client.rpc.partages.remove({ id })
    await load()
  }

  return { partages, load, create, remove }
})
