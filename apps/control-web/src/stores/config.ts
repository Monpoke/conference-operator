import type { VisibleConfig, ObsInstance } from '@conference-operator/contract'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useActionsStore } from './actions.js'
import { useRoomStore } from './room.js'

/**
 * The roles offered per instance, and nothing else.
 *
 * Three per OBS: they are the ones the page drives. A role mapped outside this
 * list — rare but legitimate — survives a save, because the draft starts from
 * what exists rather than replacing it.
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

/** What is missing before the room can be driven, said plainly. */
export interface Missing {
  /** A stable anchor: the rendering and the tests hook onto it, not onto the label. */
  code: string
  text: string
}

interface ObsDraft {
  url: string
  /** As typed. Empty means "unchanged": the page never had the password. */
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
  promptRecordingOnStop: boolean
  sceneOnStart: string
}

/**
 * The room's configuration, typed into a draft.
 *
 * The form is populated **on opening**, never on every state received: the
 * control app gets one every few seconds, and repopulating the fields under the
 * fingers would erase what is being typed. It repopulates exactly once more —
 * after a successful save — and from the state coming back from the hub, not from
 * what has just been typed: that is the only way to see what was really kept.
 *
 * Only the two OBS states, the list of their scenes, and the very possibility of
 * saving follow live.
 */
export const useConfigStore = defineStore('config', () => {
  const room = useRoomStore()
  const actions = useActionsStore()

  const open = ref(false)
  const draft = ref<ConfigDraft | null>(null)
  const saving = ref(false)
  const notice = ref<{ text: string; tone: 'quiet' | 'ok' | 'alert' } | null>(null)

  /**
   * The panel was opened by the start-up check, not by the operator.
   *
   * Used by the banner: a panel that opens on its own must say why, otherwise it
   * reads as a slip.
   */
  const openAtStartup = ref(false)

  const config = computed(() => room.payload?.diagnostics?.config ?? null)

  /**
   * The hub is the source of truth.
   *
   * Offline, saving would be an empty promise: what was typed would go at the
   * first successful sync, with nothing having said so.
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
      promptRecordingOnStop: current.promptRecordingOnStop !== false,
      sceneOnStart: current.sceneOnStart ?? '',
    }
  }

  function show(reason: 'operator' | 'startup' = 'operator'): void {
    seed()
    notice.value = null
    openAtStartup.value = reason === 'startup'
    open.value = true
  }

  /**
   * What is missing before the room can be driven.
   *
   * Two readers: the panel's banner, and the start-up check that decides whether
   * to open it. Both say the same thing, which avoids a panel opening on a reason
   * it does not display.
   *
   * Nothing until the hub has returned the configuration: a room nothing is known
   * about is not a badly configured room.
   */
  const missing = computed<Missing[]>(() => {
    const current = config.value
    if (current == null) return []
    const diagnostics = room.payload?.diagnostics ?? null
    const list: Missing[] = []

    for (const instance of ['A', 'B'] as const) {
      const what = instance === 'A' ? 'projection' : 'captation'
      const state = diagnostics?.obs[instance] ?? null

      // The address comes before the connection: "not connected" on an instance
      // whose address is empty would send people looking at the network.
      if (current.obs[instance].url.trim() === '') {
        list.push({
          code: `obs-${instance}-url`,
          text: `Adresse d'OBS-${instance} (${what}) non renseignée.`,
        })
      } else if (state?.connected !== true) {
        list.push({
          code: `obs-${instance}`,
          text: `OBS-${instance} (${what}) n'est pas connecté.`,
        })
      }

      // A role that is configured but absent from OBS will fail in the middle of a
      // talk, and this is where it gets fixed. Holds for both instances.
      const unresolved = state?.unresolvedRoles ?? []
      if (unresolved.length > 0) {
        list.push({
          code: `roles-${instance}`,
          text: `Rôles introuvables dans OBS-${instance} : ${unresolved.join(', ')}.`,
        })
      }
    }

    /*
     * OBS-A only. Projection with no mapped role has no button at all: neither
     * live nor holding slide. Capture, on the other hand, records perfectly well
     * with no scene role associated — many rooms never change shot during a talk,
     * and reporting them would be a false reason.
     */
    if (Object.keys(current.sceneRoles.A ?? {}).length === 0) {
      list.push({ code: 'scenes-A', text: "Aucune scène associée aux rôles d'OBS-A." })
    }

    if ((current.recordingRoot ?? '').trim() === '') {
      list.push({
        code: 'vod',
        text:
          'Dossier des VOD non renseigné : la régie le demande alors à OBS-B, et ' +
          "n'a plus rien à relire dès qu'il est éteint.",
      })
    }

    return list
  })

  const check = ref<'waiting' | 'armed' | 'done'>('waiting')
  let stopWatchdog: (() => void) | null = null

  function judge(): boolean {
    if (config.value == null) return false
    check.value = 'done'
    stopWatchdog?.()
    stopWatchdog = null
    if (missing.value.length > 0) show('startup')
    return true
  }

  /**
   * Opens the configuration at start-up if the room is not ready.
   *
   * **Straight away**, as soon as the machine is paired and the hub has returned
   * the configuration: that is the first moment the panel makes sense, and setting
   * a room up happens before the first talk, not during it. Nothing is deferred —
   * a badly configured room must say so when the window opens, while somebody is
   * still in front of the screen.
   *
   * The "OBS is not connected" lines can disappear on their own a few seconds
   * later, the machine retrying every three seconds: the list is a computation
   * over the current state, and it empties as the instances plug in, with the
   * panel open.
   *
   * **Once per page load.** A panel that reopens after being closed is no longer
   * a reminder, it is an obstacle: a room with no OBS-B plugged in stays drivable
   * for everything else, and the operator who has read the list must be able to
   * work.
   */
  function checkAtStartup(): void {
    if (check.value !== 'waiting') return
    check.value = 'armed'
    if (judge()) return
    // The hub has not returned the configuration yet. We judge as soon as it
    // arrives: otherwise a room slow to synchronise would never be examined.
    stopWatchdog = watch(config, () => void judge())
  }

  /** What the form says, in the shape the hub expects. */
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

    // We start from what exists: a role mapped outside the three offered here
    // must not disappear on save.
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
      promptRecordingOnStop: form.promptRecordingOnStop,
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
      : { text: result.message ?? 'Échec', tone: 'alert' }
    // Repopulated from the state coming back from the hub, not from what was typed.
    if (result.ok) seed()
  }

  /**
   * Connecting an instance, settings included.
   *
   * Saving first: plugging into the old address while the new one is on screen
   * would give a successful connection to the wrong OBS, and nothing to say so.
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

  /**
   * Can the machine open a folder picker?
   *
   * The page cannot guess: it runs just as well in the machine's Electron window
   * as in a browser opened beside it, and the same bundle serves both. It is the
   * machine that answers.
   */
  const canBrowse = computed(() => config.value?.canBrowse === true)

  /**
   * Opens the **machine's** picker and fills in the VOD folder field.
   *
   * A disk path can only be typed by hand without error when one has it in front
   * of them — and it is the room machine's disk it names, wherever this page is
   * being read.
   *
   * **Nothing is saved along the way**: "Enregistrer" is what decides, as for the
   * rest of the panel. A picker that wrote straight away would turn a glance at
   * the directory tree into a change to the room. And giving up leaves the field
   * as it was: closing a picker is a gesture, not a failure.
   */
  async function browse(): Promise<void> {
    const { detail } = await useActionsStore().act({ action: 'config.chooseFolder' }, { silent: true })
    if (typeof detail === 'string' && detail !== '' && draft.value != null) {
      draft.value.recordingRoot = detail
    }
  }

  return {
    open,
    draft,
    saving,
    notice,
    config,
    online,
    canBrowse,
    missing,
    openAtStartup,
    show,
    seed,
    patch,
    save,
    connect,
    refreshScenes,
    browse,
    checkAtStartup,
  }
})
