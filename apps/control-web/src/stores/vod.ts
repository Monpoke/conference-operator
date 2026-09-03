import type { VodEntry, UploadRow, VodList, UploadsView } from '@cloudnord/contract'
import { useToast } from '@cloudnord/components'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useActionsStore } from './actions.js'
import { useRoomStore } from './room.js'

/**
 * Checking the footage.
 *
 * The question this modal answers is the one asked while packing up: "have we
 * really got everything?" The control app's stopwatch said we were recording; it
 * does not say OBS was really writing anything usable. Between the two there is a
 * full disk, an encoder that gave out, a capture card unplugged — and nobody
 * notices before editing, when the room no longer exists.
 *
 * Nothing is loaded until it is opened: reading the recordings folder on every
 * clock tick would cost one disk access a second for a list consulted three times
 * a day.
 */

/**
 * Polling while the modal is open, and only then.
 *
 * Three seconds: enough for a percentage to advance before one's eyes, little
 * enough that a room whose modal is closed — that is, all day long — generates no
 * traffic at all.
 */
export const UPLOADS_POLL_MS = 3000

/** Twenty seconds: enough to hear the sound and see the framing, no more. */
export const EXTRACT_MS = 20_000

/** Weight of the last rate reading in the moving average — see `smooth`. */
export const SMOOTHING = 1 / 3

export const VERDICT_BADGES: Record<string, [string, string]> = {
  ok: ['Exploitable', 'border-ok/50 text-ok'],
  suspect: ['À revoir', 'border-warn/50 text-warn'],
  illisible: ['Illisible', 'border-alert/60 text-alert'],
}

export const UPLOAD_WORDS: Record<string, string> = {
  attente: 'téléversement en attente',
  'en-cours': 'téléversement en cours',
  termine: 'téléversé',
  abandonne: 'téléversement abandonné',
  echoue: 'téléversement en échec',
}

export const useVodStore = defineStore('vod', () => {
  const room = useRoomStore()
  const actions = useActionsStore()
  const toast = useToast()

  const open = ref(false)
  const listing = ref<VodList | null>(null)
  const uploads = ref<UploadsView | null>(null)
  /** The footage unfolded for preview, and the point in the file being watched. */
  const preview = ref<{ file: string; at: number } | null>(null)
  const checking = ref(false)
  const progress = ref('')
  /** Smoothed rate per file, in bytes per second — see `smooth`. */
  const rates = ref(new Map<string, number>())

  let timer: ReturnType<typeof setInterval> | null = null

  async function loadListing(): Promise<void> {
    try {
      const response = await fetch('/control/recordings')
      const body = (await response.json()) as VodList & { ok?: boolean; message?: string }
      listing.value = { root: body.root ?? null, entries: body.entries ?? [], tools: body.tools }
      if (body.ok === false && body.message != null) toast.fail(body.message)
    } catch {
      listing.value = { root: null, entries: [], tools: null as never }
      toast.fail('Le service local ne répond pas')
    }
  }

/**
   * Uploads under way, polled rather than pushed.
   *
   * The same choice as the machine's load: an advancing percentage placed in the
   * state stream would republish the whole diagnostic on every part. Here, only an
   * open modal asks.
   */
  async function loadUploads(): Promise<void> {
    try {
      const response = await fetch('/control/uploads')
      const body = (await response.json()) as UploadsView & { ok?: boolean }
      uploads.value = body.ok === false ? null : body
      smooth()
    } catch {
      uploads.value = null
    }
  }

  /**
   * Picks up each in-flight file's rate, smoothing it.
   *
   * `debitOctetsS` is the rate of the **last part**, measured on its own. On an
   * event's network it varies threefold from one part to the next, and a remaining
   * time computed from it would jump from "4 min" to "11 min" every three seconds.
   * A figure that dances cannot be read: one stops looking at it, and it may as
   * well not be displayed.
   *
   * One third of the weight to the last reading: reactive enough to follow an
   * uplink that clears in a few tens of seconds, slow enough not to follow one
   * unlucky part.
   *
   * Forgotten as soon as the file is no longer in flight: a resume after a cut
   * starts again on the network of the moment, and inheriting last night's rate
   * would announce a time that never existed.
   */
  function smooth(): void {
    for (const entry of uploads.value?.entries ?? []) {
      if (entry.state !== 'en-cours' || entry.debitOctetsS == null || entry.debitOctetsS <= 0) {
        rates.value.delete(entry.file)
        continue
      }
      const previous = rates.value.get(entry.file)
      rates.value.set(
        entry.file,
        previous == null ? entry.debitOctetsS : previous + (entry.debitOctetsS - previous) * SMOOTHING,
      )
    }
  }

  /**
   * What prevents any upload, individual or global — or nothing.
   *
   * A single rule for both buttons. Kept apart, they had diverged: the rows no
   * longer offered a ⬆ for want of a destination, while "Tout téléverser" stayed
   * active in the header. The control app therefore read as "everything can be
   * sent, but nothing in particular" — the exact opposite of the real state, and
   * the only explanation available was to click.
   *
   * Covers background unavailability only. A passing wait — a running take, a
   * capped rate — leaves the buttons: the request is queued, and the banner above
   * says what is being waited for.
   */
  const blocked = computed<string | null>(() => {
    if (uploads.value == null) return 'État des téléversements indisponible'
    if (uploads.value.verdict?.reason === 'sans-stockage') {
      return uploads.value.verdict.text ?? 'aucun stockage configuré sur le hub'
    }
    return null
  })

  /**
   * The hub knows where to send, but sends nothing of its own accord.
   *
   * Blocks **nothing**: this is the hub's default setting — "nothing leaves unless
   * asked" — and the regulator already accepts manual requests in this state. The
   * two reasons long shared one code, and the control app withdrew its buttons
   * here as on a hub with no storage: a perfectly configured installation then
   * offered no way of sending anything at all.
   *
   * It still has to be said, on one discreet line: otherwise the operator who
   * uploads footage by hand wonders why the rest do not leave on their own.
   */
  const manualOnly = computed<boolean>(
    () => uploads.value?.verdict?.reason === 'auto-desactive',
  )

  /**
   * Nothing to say when all is well, nor when there is nothing to make go.
   *
   * Neither `sans-stockage` nor `auto-desactive` is a wait: the first is a hub
   * with no destination, so a feature nobody asked for; the second is a deliberate
   * setting, the default one. Announcing them in amber every time the modal opens,
   * all day long, would make them look like failures — and would wear the banner
   * out before the day it tells the truth.
   */
  const waitReason = computed<string | null>(() => {
    const verdict = uploads.value?.verdict
    if (verdict == null || verdict.allowed) return null
    // Neither the missing storage nor the disabled automation is a wait: the
    // first is said in the header, the second is a deliberate setting.
    if (verdict.reason === 'sans-stockage' || verdict.reason === 'auto-desactive') return null
    return `Téléversement en attente — ${verdict.text}.`
  })

  /** A file's upload state, or null if it was never queued. */
  function uploadOf(file: string): UploadRow | null {
    return (uploads.value?.entries ?? []).find((entry) => entry.file === file) ?? null
  }

  /**
   * What is left to wait on a file, in milliseconds — or nothing.
   *
   * The packing-up question is not "how far along is it?" but "can I unplug this
   * disk before I leave?", and a percentage does not answer it: 60 % on four
   * gigabytes of footage is two minutes or forty, depending on a rate the operator
   * has no reason to know.
   *
   * The hub's ceiling enters the computation, and it must: the reported rate is
   * that of sending one part, measured **before** the pause that applies the
   * ceiling. On a hub set to one megabyte a second, an uplink capable of ten times
   * that would therefore announce ten times less time than reality — an estimate
   * that is too short is worse than no estimate, it is what makes people put the
   * disk away too early.
   *
   * Null while no part has left: "any moment now" on a queue that has not started
   * would be an invented promise.
   */
  function etaOf(file: string): number | null {
    const entry = uploadOf(file)
    if (entry == null || entry.state !== 'en-cours') return null
    const smoothed = rates.value.get(file)
    if (smoothed == null || smoothed <= 0 || !(entry.remainingBytes > 0)) return null
    const ceiling = uploads.value?.verdict?.debitMaxOctetsS ?? null
    const rate = ceiling != null && ceiling > 0 ? Math.min(smoothed, ceiling) : smoothed
    return Math.round((entry.remainingBytes / rate) * 1000)
  }

  function show(): void {
    open.value = true
    // Read again on every opening: the folder has filled up since last time.
    listing.value = null
    preview.value = null
    uploads.value = null
    rates.value.clear()
    void loadListing()
    void loadUploads()
    // Cut on closing, failing which it would outlive every opening of the day.
    timer ??= setInterval(() => void loadUploads(), UPLOADS_POLL_MS)
  }

  function hide(): void {
    open.value = false
    if (timer != null) clearInterval(timer)
    timer = null
  }

  /** Unfolds a file's preview, or folds it back if it is already showing. */
  function togglePreview(file: string): void {
    preview.value = preview.value?.file === file ? null : { file, at: 0 }
  }

  async function inspect(file: string): Promise<void> {
    await actions.act({ action: 'vod.inspect', file })
    await loadListing()
  }

  /**
   * The same button sets and clears the verdict.
   *
   * Without the clearing, a slip would stay on screen with no way to take it back
   * — and it is the kind of mark that gets read back at editing time as
   * information.
   */
  async function verdict(file: string, status: 'ok' | 'illisible'): Promise<void> {
    const entry = (listing.value?.entries ?? []).find((candidate) => candidate.file === file)
    const already =
      entry?.check != null && entry.check.by === 'operateur' && entry.check.status === status
    await actions.act({ action: 'vod.verdict', file, status: already ? null : status })
    await loadListing()
  }

  /**
   * Checking the whole folder, one file after another.
   *
   * In series, not in parallel: ffprobe really reads the files, and launching six
   * reads of two-hour recordings on the disk that is recording is exactly what one
   * does not want during a talk. With no per-file toast either — twelve messages
   * in a row say nothing more than the count shown at the top.
   */
  async function checkAll(): Promise<void> {
    const targets = (listing.value?.entries ?? []).map((entry) => entry.file)
    if (checking.value || targets.length === 0) return

    checking.value = true
    try {
      for (const [index, file] of targets.entries()) {
        progress.value = `contrôle ${index + 1} / ${targets.length}`
        try {
          await fetch('/control/action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'vod.inspect', file }),
          })
        } catch {
          toast.fail('Le service local ne répond pas')
          break
        }
      }
    } finally {
      checking.value = false
      progress.value = ''
    }

    await loadListing()
    const doubtful = (listing.value?.entries ?? []).filter(
      (entry) => entry.check != null && entry.check.status !== 'ok',
    )
    if (doubtful.length === 0) {
      toast.say(`${targets.length} enregistrement(s) contrôlé(s), rien à signaler`)
    } else {
      toast.fail(`${doubtful.length} enregistrement(s) à revoir`)
    }
  }

  /**
   * Queues one file, or everything that is left.
   *
   * No confirmation window, and above all not a native one: it blocks the page's
   * render loop, and therefore the stopwatch and the rooms strip, in the middle of
   * a talk. The gesture is not destructive anyway — it queues, it reads nothing
   * straight away.
   *
   * The only case that deserves a word is a running take: it is the only one where
   * the regulator will refuse *despite* the manual request, because one does not
   * read the disk a master is being written to.
   */
  async function upload(file: string | null): Promise<void> {
    const result = await actions.act({ action: 'vod.upload', file })
    if (result.ok && room.payload?.state.recording === true) {
      toast.say('Mis en file — départ à l’arrêt de la captation en cours')
    }
    await loadUploads()
  }

  async function cancelUpload(file: string): Promise<void> {
    await actions.act({ action: 'vod.upload.cancel', file })
    await loadUploads()
  }

  /**
   * What the machine does not have, said once at the top rather than discovered
   * button by button.
   */
  const missingTools = computed<string | null>(() => {
    const tools = listing.value?.tools
    if (tools == null) return null
    const consequences: string[] = []
    if (!tools.ffprobe) consequences.push('« Vérifier » se limite à la taille et au sidecar')
    if (!tools.ffmpeg) consequences.push('les aperçus ne peuvent pas être produits')
    if (consequences.length === 0) return null
    const head =
      !tools.ffprobe && !tools.ffmpeg
        ? 'ffmpeg et ffprobe introuvables sur cette machine : '
        : !tools.ffprobe
          ? 'ffprobe introuvable : '
          : 'ffmpeg introuvable : '
    return `${head}${consequences.join(', ')}.`
  })

  function entryOf(file: string): VodEntry | null {
    return (listing.value?.entries ?? []).find((entry) => entry.file === file) ?? null
  }

  return {
    open,
    listing,
    uploads,
    preview,
    checking,
    progress,
    blocked,
    waitReason,
    missingTools,
    show,
    hide,
    loadListing,
    loadUploads,
    uploadOf,
    etaOf,
    manualOnly,
    entryOf,
    togglePreview,
    inspect,
    verdict,
    checkAll,
    upload,
    cancelUpload,
  }
})
