import type { ConfigVisible, ObsInstance } from '@cloudnord/contract'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useActionsStore } from './actions.js'
import { useRoomStore } from './room.js'

/**
 * Les rôles proposés par instance, et rien d'autre.
 *
 * Trois par OBS : ce sont ceux que la page pilote. Un rôle mappé hors de cette
 * liste — cas rare mais légitime — survit à l'enregistrement, parce que le
 * brouillon repart de l'existant plutôt que de le remplacer.
 */
export const ROLES: Record<ObsInstance, { role: string; label: string }[]> = {
  A: [
    { role: 'LIVE', label: 'Direct' },
    { role: 'HOLD', label: 'Habillage' },
    { role: 'RELAY', label: 'Relais' },
  ],
  B: [
    { role: 'TALK', label: 'Talk complet' },
    { role: 'CAM_ONLY', label: 'Caméra seule' },
    { role: 'SLIDES_ONLY', label: 'Slides seules' },
  ],
}

interface ObsDraft {
  url: string
  /** Saisi. Vide vaut « inchangé » : la page n'a jamais eu le mot de passe. */
  password: string
  clearPassword: boolean
}

export interface ConfigDraft {
  obs: Record<ObsInstance, ObsDraft>
  sceneRoles: Record<ObsInstance, Record<string, string>>
  displayPort: string
  recordingRoot: string
  fileSlug: string
  relaySourceRoomId: string
  promptRecordingOnStart: boolean
  sceneOnStart: string
}

/**
 * La configuration de la salle, saisie sur un brouillon.
 *
 * Le formulaire est peuplé **à l'ouverture**, jamais à chaque état reçu : la
 * régie en reçoit un toutes les quelques secondes, et repeupler les champs sous
 * les doigts effacerait la saisie en cours. Il se repeuple une seule autre
 * fois — après un enregistrement réussi — et sur l'état qui revient du hub, pas
 * sur ce qu'on vient de taper : c'est la seule façon de voir ce qui a réellement
 * été retenu.
 *
 * Ne suivent en direct que l'état des deux OBS, la liste de leurs scènes, et la
 * possibilité même d'enregistrer.
 */
export const useConfigStore = defineStore('config', () => {
  const room = useRoomStore()
  const actions = useActionsStore()

  const open = ref(false)
  const draft = ref<ConfigDraft | null>(null)
  const saving = ref(false)
  const notice = ref<{ text: string; tone: 'quiet' | 'ok' | 'alerte' } | null>(null)

  const config = computed(() => room.payload?.diagnostics?.config ?? null)

  /**
   * Le hub est la source de vérité.
   *
   * Hors ligne, enregistrer serait une promesse en l'air : la saisie repartirait
   * au premier sync réussi, sans que rien ne l'ait dit.
   */
  const online = computed(() => room.payload?.state.connectivity === 'ONLINE')

  function seed(): void {
    const current = config.value
    if (current == null) {
      draft.value = null
      return
    }
    const obs = (instance: ObsInstance): ObsDraft => ({
      url: current.obs[instance].url,
      password: '',
      clearPassword: false,
    })
    draft.value = {
      obs: { A: obs('A'), B: obs('B') },
      sceneRoles: {
        A: { ...(current.sceneRoles.A ?? {}) },
        B: { ...(current.sceneRoles.B ?? {}) },
      },
      displayPort: String(current.displayPort),
      recordingRoot: current.recordingRoot ?? '',
      fileSlug: current.fileSlug ?? '',
      relaySourceRoomId: current.relaySourceRoomId ?? '',
      promptRecordingOnStart: current.promptRecordingOnStart !== false,
      sceneOnStart: current.sceneOnStart ?? '',
    }
  }

  function show(): void {
    seed()
    notice.value = null
    open.value = true
  }

  /** Ce que le formulaire dit, sous la forme attendue par le hub. */
  function patch(): Record<string, unknown> | null {
    const current = config.value
    const form = draft.value
    if (current == null || form == null) return null

    const point = (instance: ObsInstance): Record<string, unknown> => {
      const value: Record<string, unknown> = { url: form.obs[instance].url.trim() }
      if (form.obs[instance].clearPassword) value.password = null
      else if (form.obs[instance].password.length > 0) value.password = form.obs[instance].password
      return value
    }

    // On repart de l'existant : un rôle mappé hors des trois proposés ici ne
    // doit pas disparaître à l'enregistrement.
    const roles = (instance: ObsInstance): Record<string, string> => {
      const next: Record<string, string> = { ...(current.sceneRoles[instance] ?? {}) }
      for (const { role } of ROLES[instance]) {
        const value = form.sceneRoles[instance][role] ?? ''
        if (value === '') delete next[role]
        else next[role] = value
      }
      return next
    }

    const text = (value: string): string | null => (value.trim() === '' ? null : value.trim())

    return {
      obs: { A: point('A'), B: point('B') },
      sceneRoles: { A: roles('A'), B: roles('B') },
      displayPort: Number(form.displayPort) || current.displayPort,
      recordingRoot: text(form.recordingRoot),
      fileSlug: text(form.fileSlug),
      relaySourceRoomId: form.relaySourceRoomId === '' ? null : form.relaySourceRoomId,
      promptRecordingOnStart: form.promptRecordingOnStart,
      sceneOnStart: form.sceneOnStart === '' ? null : form.sceneOnStart,
    }
  }

  async function save(): Promise<void> {
    const body = patch()
    if (body == null) return
    saving.value = true
    notice.value = { text: 'Enregistrement…', tone: 'quiet' }
    const result = await actions.act({ action: 'room.configure', patch: body })
    saving.value = false
    notice.value = result.ok
      ? { text: 'Enregistré.', tone: 'ok' }
      : { text: result.message ?? 'Échec', tone: 'alerte' }
    // Repeuplé sur l'état qui revient du hub, pas sur ce qu'on vient de taper.
    if (result.ok) seed()
  }

  /**
   * Connecter une instance, réglages compris.
   *
   * Enregistrer d'abord : brancher sur l'ancienne adresse pendant que la
   * nouvelle est à l'écran donnerait une connexion réussie sur le mauvais OBS,
   * et rien pour le dire.
   */
  async function connect(instance: ObsInstance): Promise<void> {
    if (online.value) {
      const body = patch()
      if (body != null) {
        const saved = await actions.act({ action: 'room.configure', patch: body })
        if (!saved.ok) return
        seed()
      }
    }
    await actions.act({ action: 'obs.connect', instance })
  }

  async function refreshScenes(): Promise<void> {
    await actions.act({ action: 'obs.refreshScenes' })
  }

  return { open, draft, saving, notice, config, online, show, seed, patch, save, connect, refreshScenes }
})
