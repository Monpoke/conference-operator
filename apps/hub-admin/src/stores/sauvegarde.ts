import { defineStore } from 'pinia'
import { useSessionStore } from './session.js'

export interface RestaurationReport {
  lignes: Record<string, number>
  comptesIgnores: string[]
  fichiers: { images: number; themes: number }
  aRessaisir: string[]
}

/**
 * The hub's whole configuration, out and back in. A plain HTTP route rather
 * than a procedure: the file runs to tens of megabytes. The download is a link;
 * the restore sends the file as it was saved.
 */
export const useSauvegardeStore = defineStore('sauvegarde', () => {
  const session = useSessionStore()

  async function restore(file: Blob, fetchImpl: typeof fetch = fetch): Promise<RestaurationReport> {
    const token = session.client.token.read()
    const response = await fetchImpl('/sauvegarde/import', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(token == null ? {} : { authorization: `Bearer ${token}` }) },
      body: file,
    })
    const body = (await response.json().catch(() => ({}))) as RestaurationReport & { error?: string }
    if (!response.ok) throw new Error(body.error ?? `Restauration refusée (${response.status})`)
    return body
  }

  return { restore }
})
