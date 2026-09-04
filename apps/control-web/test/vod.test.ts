import type { VodEntry } from '@cloudnord/contract'
import { useToast } from '@cloudnord/components'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import VodDialog from '../src/components/VodDialog.vue'
import VodRow from '../src/components/VodRow.vue'
import { useRoomStore } from '../src/stores/room.js'
import { useVodStore } from '../src/stores/vod.js'
import { payload } from './fixtures.js'

/**
 * Checking the footage, and the packing-up question.
 *
 * "Have we really got everything?" The control app's stopwatch said we were
 * recording; it does not say OBS was writing anything usable. In between: a full
 * disk, an encoder that gave out, a capture card unplugged — and nobody notices
 * before editing, when the room no longer exists.
 */

const RUSH: VodEntry = {
  file: 'track-1/2026-10-30-09h00.mkv',
  sizeBytes: 4_200_000_000,
  modifiedAtMs: 0,
  beingWritten: false,
  sidecar: {
    sessionId: 'talk-1',
    title: 'Ce que le flux ne dit pas',
    speakers: [{ name: 'Camille Roux', company: null }],
    roomId: 'track-1',
    trackTitle: null,
    category: null,
    startedAt: '2026-10-30T09:00:00.000Z',
    endedAt: '2026-10-30T09:45:00.000Z',
    durationMs: 2_700_000,
    markers: [{ label: 'Questions', offsetMs: 2_400_000, at: '2026-10-30T09:40:00.000Z' }],
    videoFile: null,
  },
  check: null,
}

const OUTILS = { ffmpeg: true, ffprobe: true }

interface Appel {
  url: string
  body: unknown
}

let calls: Appel[]
let listing: Record<string, unknown>
let uploads: Record<string, unknown>

function stub(): void {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body == null ? null : JSON.parse(String(init.body)) })
    const corps =
      url === '/control/recordings' ? listing : url === '/control/uploads' ? uploads : { ok: true }
    return new Response(JSON.stringify(corps), { headers: { 'content-type': 'application/json' } })
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  useToast().clear()
  calls = []
  listing = { root: '/rushes', entries: [RUSH], tools: OUTILS }
  uploads = { ok: true, entries: [], verdict: { allowed: true, reason: null, text: '' } }
  useRoomStore().seed(payload())
  stub()
})

async function openVod(): Promise<ReturnType<typeof useVodStore>> {
  const vod = useVodStore()
  vod.show()
  await flushPromises()
  return vod
}

describe('opening', () => {
  it('reads the disk only on opening', async () => {
    const vod = useVodStore()

    // Reading the folder on every clock tick would cost one disk access a second
    // for a list consulted three times a day.
    expect(calls).toEqual([])

    vod.show()
    await flushPromises()
    expect(calls.map((call) => call.url)).toContain('/control/recordings')
  })

  it('reads the folder again on every opening', async () => {
    const vod = await openVod()
    vod.hide()
    calls = []

    vod.show()
    await flushPromises()

    // It has filled up since last time.
    expect(calls.filter((call) => call.url === '/control/recordings')).toHaveLength(1)
  })

  it('cuts the polling on closing', async () => {
    vi.useFakeTimers()
    const vod = useVodStore()
    vod.show()
    vod.hide()
    calls = []

    vi.advanceTimersByTime(20_000)
    vi.useRealTimers()

    // Failing which it would outlive every opening of the day.
    expect(calls.filter((call) => call.url === '/control/uploads')).toEqual([])
  })
})

describe('what the modal says when there is nothing', () => {
  it('names the cause of an unknown folder, rather than an empty list', async () => {
    listing = { root: null, entries: [], tools: OUTILS }
    await openVod()
    const wrapper = mount(VodDialog, { props: { timeZone: 'Europe/Paris' }, attachTo: document.body })
    await flushPromises()

    // An empty list would read as a lost day.
    expect(document.body.textContent).toContain('Aucun dossier d’enregistrement connu')
    wrapper.unmount()
  })

  it('signale une machine sans ffprobe, une fois en haut', async () => {
    listing = { root: '/rushes', entries: [RUSH], tools: { ffmpeg: true, ffprobe: false } }
    const vod = await openVod()

    // Said once rather than discovered button by button.
    expect(vod.missingTools).toContain('ffprobe introuvable')
    expect(vod.missingTools).toContain('taille et au sidecar')
  })
})

describe('uploading', () => {
  it('removes the buttons everywhere when there is nowhere to send', async () => {
    uploads = {
      ok: true,
      entries: [],
      verdict: { allowed: false, reason: 'sans-stockage', text: 'aucun stockage configuré sur le hub' },
    }
    const vod = await openVod()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    /*
     * A single rule for both buttons: kept apart, they had diverged, and the control
     * app read as "everything can be sent, but nothing in particular" — the exact
     * opposite of the real state.
     */
    expect(vod.blocked).toBe('aucun stockage configuré sur le hub')
    expect(wrapper.find('[data-vod-monter]').exists()).toBe(false)
  })

  it('keeps the buttons when only automatic mode is off', async () => {
    /*
     * The hub's **default** setting: nothing leaves unless asked. The two reasons
     * shared one code, and the control app withdrew its buttons here as on a hub
     * with no storage — a perfectly configured installation then offered no way of
     * sending anything at all, while the regulator was already accepting manual
     * requests.
     */
    uploads = {
      ok: true,
      entries: [],
      verdict: {
        allowed: false,
        reason: 'auto-desactive',
        text: 'téléversement automatique désactivé',
      },
    }
    const vod = await openVod()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    expect(vod.blocked).toBe(null)
    expect(vod.manualOnly).toBe(true)
    expect(wrapper.find('[data-vod-monter]').exists()).toBe(true)
    // No amber: it is a deliberate setting, not a wait.
    expect(vod.waitReason).toBe(null)
  })

  it('says at the top that sending is done by hand', async () => {
    uploads = {
      ok: true,
      entries: [],
      verdict: {
        allowed: false,
        reason: 'auto-desactive',
        text: 'téléversement automatique désactivé',
      },
    }
    await openVod()
    const wrapper = mount(VodDialog, { props: { timeZone: 'Europe/Paris' }, attachTo: document.body })
    await flushPromises()

    // Failing which the operator who has just sent one by hand wonders
    // pourquoi les suivants ne partent pas seuls.
    const ligne = document.body.querySelector('[data-role="vod-manual"]')
    expect(ligne?.textContent).toContain('les envois se font à la main')
    // "Tout téléverser" stays armed: the same rule as the rows' ⬆.
    expect(
      document.body.querySelector('[data-role="btn-vod-upload-all"]')?.hasAttribute('disabled'),
    ).toBe(false)
    wrapper.unmount()
  })

  it('se tait sur une absence de stockage, et parle d’une attente', async () => {
    uploads = {
      ok: true,
      entries: [],
      verdict: { allowed: false, reason: 'sans-stockage', text: 'aucun stockage' },
    }
    let vod = await openVod()

    /*
     * `sans-stockage` is not a wait: it is a feature nobody asked for. Announcing it
     * in amber all day long would make it look like a failure, and would wear the
     * banner out before the day it tells the truth.
     */
    expect(vod.waitReason).toBe(null)

    setActivePinia(createPinia())
    useRoomStore().seed(payload())
    uploads = {
      ok: true,
      entries: [],
      verdict: { allowed: false, reason: 'conference', text: 'conférence dans 6 min' },
    }
    vod = await openVod()
    expect(vod.waitReason).toBe('Téléversement en attente — conférence dans 6 min.')
  })

  it('does not offer to resend footage already at the storage', async () => {
    uploads = {
      ok: true,
      entries: [{ file: RUSH.file, state: 'termine', percent: 100, remainingBytes: 0, debitOctetsS: null, error: null, manual: false }],
      verdict: { allowed: true, reason: null, text: '' },
    }
    await openVod()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    // A button would pay three gigabytes again on the event's network at the
    // premier clic distrait.
    expect(wrapper.find('[data-vod-monter]').exists()).toBe(false)
    expect(wrapper.find('[data-vod-annuler]').exists()).toBe(false)
    expect(wrapper.text()).toContain('☁')
  })

  it('offers to cancel what is in flight, without losing the indicator', async () => {
    uploads = {
      ok: true,
      entries: [{ file: RUSH.file, state: 'en-cours', percent: 42, remainingBytes: 2_400_000_000, debitOctetsS: 12_000_000, error: null, manual: true }],
      verdict: { allowed: true, reason: null, text: '' },
    }
    await openVod()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    expect(wrapper.text()).toContain('téléversement en cours — 42 %')

    /*
     * The ⬆ gave way to "Annuler", and the row lost at a stroke the only landmark
     * that said where that particular file stood: on a modal lining up fifteen of
     * them, one had to read the small detail line again to find the one uploading.
     */
    const indicator = wrapper.get('[data-vod-progression]')
    expect(indicator.attributes('title')).toContain('42 %')
    expect(indicator.get('span').classes()).toContain('animate-spin')

    await wrapper.get('[data-vod-annuler]').trigger('click')
    await flushPromises()
    expect(calls.at(-2)?.body).toEqual({ action: 'vod.upload.cancel', file: RUSH.file })
  })

  it('bat au lieu de tourner tant que rien ne part encore', async () => {
    // A spinner on a queue would suggest an upload going nowhere: it spins when
    // bytes are leaving, it pulses otherwise.
    uploads = {
      ok: true,
      entries: [{ file: RUSH.file, state: 'attente', percent: 0, remainingBytes: 4_200_000_000, debitOctetsS: null, error: null, manual: true }],
      verdict: { allowed: false, reason: 'conference', text: 'conférence en cours' },
    }
    await openVod()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    const indicator = wrapper.get('[data-vod-progression]')
    expect(indicator.attributes('title')).toContain('En file')
    expect(indicator.get('span').classes()).toContain('animate-pulse')
    expect(indicator.get('span').classes()).not.toContain('animate-spin')
    // Cancelling is still offered: an upload that has not started can be abandoned too.
    expect(wrapper.find('[data-vod-annuler]').exists()).toBe(true)
  })

  it('says the time left, which the percentage leaves whole', async () => {
    /*
     * The packing-up question is not "how far along is it?" but "can I unplug this
     * disk before I leave?". 60 % on four gigabytes of footage is two minutes or
     * forty, depending on a rate the operator has no reason to know.
     */
    uploads = {
      ok: true,
      entries: [
        {
          file: RUSH.file,
          state: 'en-cours',
          percent: 40,
          remainingBytes: 60_000_000,
          debitOctetsS: 1_000_000,
          error: null,
          manual: true,
        },
      ],
      verdict: { allowed: true, reason: null, text: '', debitMaxOctetsS: null },
    }
    await openVod()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    // Sixty megabytes at one megabyte a second.
    expect(wrapper.text()).toContain('téléversement en cours — 40 % · reste 1 min')
    // "environ" on the indicator: what is worth whatever the network is worth reads
    // comme une estimation, sans quoi on range le disque sur la foi du chiffre.
    expect(wrapper.get('[data-vod-progression]').attributes('title')).toContain(
      'reste environ 1 min',
    )
  })

  it('counts with the hub\'s ceiling, not with one part\'s speed', async () => {
    /*
     * The reported rate is that of sending one part, measured *before* the pause
     * that applies the ceiling. Without the ceiling in the computation, an uplink
     * ten times faster than the setting would announce ten times less time — and an
     * estimate that is too short is worse than no estimate at all.
     */
    uploads = {
      ok: true,
      entries: [
        {
          file: RUSH.file,
          state: 'en-cours',
          percent: 40,
          remainingBytes: 60_000_000,
          debitOctetsS: 10_000_000,
          error: null,
          manual: true,
        },
      ],
      verdict: { allowed: true, reason: null, text: '', debitMaxOctetsS: 1_000_000 },
    }
    const vod = await openVod()

    expect(vod.etaOf(RUSH.file)).toBe(60_000)
  })

  it('smooths the rate, so the figure does not dance', async () => {
    /*
     * `debitOctetsS` is the last part's rate, measured on its own: on an event's
     * network it varies threefold from one part to the next. Raw, the time left
     * would jump from "1 min" to "10 min" every three seconds — a figure that
     * dances is a figure one stops looking at.
     */
    const row = (debitOctetsS: number): Record<string, unknown> => ({
      ok: true,
      entries: [
        {
          file: RUSH.file,
          state: 'en-cours',
          percent: 40,
          remainingBytes: 60_000_000,
          debitOctetsS,
          error: null,
          manual: true,
        },
      ],
      verdict: { allowed: true, reason: null, text: '', debitMaxOctetsS: null },
    })

    uploads = row(1_000_000)
    const vod = await openVod()

    // One unlucky part: the rate collapses at a stroke.
    uploads = row(100_000)
    await vod.loadUploads()

    // One third of the weight to the last reading: 700 kB/s, and not the 100 kB/s
    // that would have announced ten minutes.
    expect(vod.etaOf(RUSH.file)).toBe(Math.round((60_000_000 / 700_000) * 1000))
  })

  it('n’annonce aucun temps tant que rien n’est parti', async () => {
    // "Any moment now" on a queue that has not started would be an invented
    // promise: nothing has left, nothing has been measured.
    uploads = {
      ok: true,
      entries: [
        {
          file: RUSH.file,
          state: 'attente',
          percent: 0,
          remainingBytes: 4_200_000_000,
          debitOctetsS: null,
          error: null,
          manual: true,
        },
      ],
      verdict: { allowed: false, reason: 'conference', text: 'conférence dans 6 min' },
    }
    const vod = await openVod()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    expect(vod.etaOf(RUSH.file)).toBeNull()
    expect(wrapper.text()).not.toContain('reste')
  })

  it('does not cancel on a click on the indicator', async () => {
    uploads = {
      ok: true,
      entries: [{ file: RUSH.file, state: 'en-cours', percent: 80, remainingBytes: 840_000_000, debitOctetsS: 12_000_000, error: null, manual: true }],
      verdict: { allowed: true, reason: null, text: '' },
    }
    await openVod()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })
    calls = []

    await wrapper.get('[data-vod-progression]').trigger('click')
    await flushPromises()

    // Three gigabytes already uploaded are not lost to a distracted finger:
    // "Annuler" is a named button, the indicator is not one.
    expect(calls).toEqual([])
  })

  it('gives the four icons the same cell, and reserves the upload one', async () => {
    /*
     * Nothing lined up from one row to the next, for two reasons combined.
     *
     * Each button was as wide as its glyph: 👁 and ⬆ are emoji, ✓ and ✕ are text
     * characters that are far narrower. And the upload column carried sometimes a
     * ⬆, sometimes a ☁, sometimes an indicator **and** a "Annuler" button — three
     * widths, and therefore a ✓ and a ✕ that landed in the same place on no row.
     */
    uploads = {
      ok: true,
      entries: [],
      verdict: { allowed: true, reason: null, text: '' },
    }
    await openVod()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    const icones = ['data-vod-apercu', 'data-vod-monter', 'data-vod-verdict-ok', 'data-vod-verdict-ko']
    for (const marque of icones) {
      const bouton = wrapper.get(`[${marque}]`)
      expect(bouton.classes()).toContain('w-9')
      // `px-0` retire le rembourrage du bouton, qui rendait la largeur
      // dependent on the content — it is the one `tailwind-merge` must carry away.
      expect(bouton.classes()).toContain('px-0')
      expect(bouton.classes()).not.toContain('px-3')
    }

    // The column reserves the widest case's space on every row, and pushes its
    // content right: ⬆, ☁ and "Annuler" share the edge
    // qui touche le ✓.
    const colonne = wrapper.get('[data-vod-monter]').element.parentElement
    expect(colonne?.className).toContain('w-[6.75rem]')
    expect(colonne?.className).toContain('justify-end')
  })

  it('keeps the column at the same width during the upload', async () => {
    uploads = {
      ok: true,
      entries: [{ file: RUSH.file, state: 'en-cours', percent: 42, remainingBytes: 2_400_000_000, debitOctetsS: 12_000_000, error: null, manual: true }],
      verdict: { allowed: true, reason: null, text: '' },
    }
    await openVod()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    // The indicator and "Annuler" fit in the same cell as the lone ⬆ of the row
    // beside it: failing which the ✓ and the ✕ jump from one row to the next.
    const colonne = wrapper.get('[data-vod-annuler]').element.parentElement
    expect(colonne?.className).toContain('w-[6.75rem]')
    expect(wrapper.get('[data-vod-progression]').element.parentElement).toBe(colonne)
  })

  it('gives the ☁ a button\'s width, for want of being one', async () => {
    // Il n'est pas cliquable — repayer trois gigaoctets au premier clic distrait
    // is what is being avoided — but it occupies the same cell, otherwise the row shifts.
    uploads = {
      ok: true,
      entries: [{ file: RUSH.file, state: 'termine', percent: 100, remainingBytes: 0, debitOctetsS: null, error: null, manual: false }],
      verdict: { allowed: true, reason: null, text: '' },
    }
    await openVod()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    const nuage = wrapper.findAll('span').find((span) => span.text() === '☁')
    expect(nuage?.classes()).toContain('w-9')
  })

  it('aligne les noms de fichier, quel que soit le verdict', async () => {
    // "Non vérifié", "Exploitable", "À revoir" and "Illisible" are not the same
    // length: the name began at four different offsets.
    await openVod()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    expect(wrapper.get('[data-role="vod-badge"]').classes()).toContain('w-24')
  })

  it('reprend l’erreur du stockage telle quelle', async () => {
    uploads = {
      ok: true,
      entries: [{ file: RUSH.file, state: 'echoue', percent: 12, remainingBytes: 3_696_000_000, debitOctetsS: null, error: 'AccessDenied', manual: false }],
      verdict: { allowed: true, reason: null, text: '' },
    }
    await openVod()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    // The only word one can carry to whoever holds the bucket.
    expect(wrapper.text()).toContain('AccessDenied')
  })

  it('met un fichier en file, ou tout ce qui reste', async () => {
    const vod = await openVod()
    calls = []

    await vod.upload(RUSH.file)
    await vod.upload(null)

    // `null` means "everything that is left": that is what "Tout téléverser" does.
    const demandes = calls
      .map((call) => call.body as { action?: string; file?: unknown } | null)
      .filter((corps) => corps?.action === 'vod.upload')
    expect(demandes).toEqual([
      { action: 'vod.upload', file: RUSH.file },
      { action: 'vod.upload', file: null },
    ])
  })

  it('warns that a running take holds back the departure', async () => {
    useRoomStore().payload!.state.recording = true
    const vod = await openVod()

    await vod.upload(RUSH.file)

    // The only case where the regulator refuses *despite* the manual request: one
    // does not read the disk a master is being written to.
    expect(useToast().notices.value.at(-1)?.text).toContain('départ à l’arrêt de la captation')
  })
})

describe('the control app\'s verdict', () => {
  it('sets the verdict, then removes it with the same button', async () => {
    const vod = await openVod()

    await vod.verdict(RUSH.file, 'ok')
    expect(calls.at(-2)?.body).toEqual({ action: 'vod.verdict', file: RUSH.file, status: 'ok' })

    listing = {
      root: '/rushes',
      entries: [{ ...RUSH, check: { status: 'ok', at: '', by: 'operateur', reasons: [], probe: null } }],
      tools: OUTILS,
    }
    await vod.loadListing()
    await vod.verdict(RUSH.file, 'ok')

    // Without the removal, a slip would stay on screen with no way to
    // reprendre — et se relirait au editing comme une information.
    expect(calls.at(-2)?.body).toEqual({ action: 'vod.verdict', file: RUSH.file, status: null })
  })
})

describe('checking the whole folder', () => {
  it('goes through in series, one file after another', async () => {
    listing = {
      root: '/rushes',
      entries: [RUSH, { ...RUSH, file: 'b.mkv' }, { ...RUSH, file: 'c.mkv' }],
      tools: OUTILS,
    }
    const vod = await openVod()
    calls = []

    await vod.checkAll()

    /*
     * ffprobe really reads the files: launching six reads of two-hour recordings on
     * the disk that is recording is exactly what one does not want during a talk.
     */
    const inspections = calls.filter(
      (call) => (call.body as { action?: string } | null)?.action === 'vod.inspect',
    )
    expect(inspections.map((call) => (call.body as { file: string }).file)).toEqual([
      RUSH.file,
      'b.mkv',
      'c.mkv',
    ])
  })

  it('sums up in one word rather than twelve', async () => {
    listing = {
      root: '/rushes',
      entries: [
        { ...RUSH, check: { status: 'ok', at: '', by: 'auto', reasons: [], probe: null } },
        { ...RUSH, file: 'b.mkv', check: { status: 'illisible', at: '', by: 'auto', reasons: ['vide'], probe: null } },
      ],
      tools: OUTILS,
    }
    const vod = await openVod()

    await vod.checkAll()

    // Twelve messages in a row say nothing more than the count shown
    // en haut.
    expect(useToast().notices.value).toHaveLength(1)
    expect(useToast().notices.value[0]?.text).toBe('1 enregistrement(s) à revoir')
  })
})

describe('one footage row', () => {
  it('reads at a glance when, how much, and what is already missing', async () => {
    await openVod()
    const wrapper = mount(VodRow, {
      props: { entry: { ...RUSH, beingWritten: true }, timeZone: 'Europe/Paris' },
    })

    const texte = wrapper.text()
    expect(texte).toContain('1 marqueur')
    expect(texte).toContain('45:00')
    expect(texte).toContain('4,2 Go')
    expect(texte).toContain('encore en écriture')
    // No anchor on this footage: nothing is said. The take is over, no more can be
    // set, and a reproach with no remedy teaches nothing.
    expect(texte).not.toContain('rognage')
  })

  it('says what editing will trim, while the file is still there', async () => {
    await openVod()
    const entry = {
      ...RUSH,
      sidecar: {
        ...RUSH.sidecar!,
        markers: [
          { label: 'Début', offsetMs: 52_000, at: '2026-10-30T09:00:52.000Z', role: 'debut' as const },
          ...RUSH.sidecar!.markers,
          { label: 'Fin', offsetMs: 2_660_000, at: '2026-10-30T09:44:20.000Z', role: 'fin' as const },
        ],
      },
    }
    const wrapper = mount(VodRow, { props: { entry, timeZone: 'Europe/Paris' } })

    const texte = wrapper.text()
    expect(texte).toContain('rognage 00:52 → 44:20')
    // The two anchors are not chapters: only "Questions" is one.
    expect(texte).toContain('1 marqueur')
  })

  it('marks the missing anchor with a "?", rather than stay silent', async () => {
    await openVod()
    const entry = {
      ...RUSH,
      sidecar: {
        ...RUSH.sidecar!,
        markers: [
          { label: 'Début', offsetMs: 52_000, at: '2026-10-30T09:00:52.000Z', role: 'debut' as const },
        ],
      },
    }
    const wrapper = mount(VodRow, { props: { entry, timeZone: 'Europe/Paris' } })

    // Le editing ira jusqu'au bout du fichier, blancs de fin compris : le dire
    // while the room is still standing beats discovering it on the published video.
    expect(wrapper.text()).toContain('rognage 00:52 → ?')
  })

  it('dit le sidecar absent, qui est justement le cas qu’on cherche', async () => {
    await openVod()
    const wrapper = mount(VodRow, {
      props: { entry: { ...RUSH, sidecar: null }, timeZone: 'Europe/Paris' },
    })

    // OBS killed mid-stop: the footage is there, what describes it is not.
    expect(wrapper.text()).toContain('sidecar absent')
    expect(wrapper.text()).toContain('Titre inconnu')
  })

  it('explains a red badge, rather than leave it bare', async () => {
    await openVod()
    const wrapper = mount(VodRow, {
      props: {
        entry: {
          ...RUSH,
          check: { status: 'illisible', at: '', by: 'auto', reasons: ['conteneur illisible'], probe: null },
        },
        timeZone: 'Europe/Paris',
      },
    })

    expect(wrapper.text()).toContain('Illisible')
    expect(wrapper.text()).toContain('conteneur illisible')
  })
})
