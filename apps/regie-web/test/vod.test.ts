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
 * Le contrôle des rushes, et la question du démontage.
 *
 * « Est-ce qu'on a bien tout ? » Le chronomètre de la régie a dit qu'on
 * enregistrait ; il ne dit pas qu'OBS écrivait quelque chose d'exploitable.
 * Entre les deux : un disque plein, un encodeur qui a lâché, une carte
 * d'acquisition débranchée — et personne ne s'en aperçoit avant le montage,
 * quand la salle n'existe plus.
 */

const RUSH = {
  file: 'track-1/2026-10-30-09h00.mkv',
  sizeBytes: 4_200_000_000,
  modifiedAtMs: 0,
  enEcriture: false,
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

let appels: Appel[]
let listing: Record<string, unknown>
let uploads: Record<string, unknown>

function stub(): void {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    appels.push({ url, body: init?.body == null ? null : JSON.parse(String(init.body)) })
    const corps =
      url === '/control/recordings' ? listing : url === '/control/uploads' ? uploads : { ok: true }
    return new Response(JSON.stringify(corps), { headers: { 'content-type': 'application/json' } })
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  useToast().clear()
  appels = []
  listing = { root: '/rushes', entries: [RUSH], outils: OUTILS }
  uploads = { ok: true, entrees: [], verdict: { autorise: true, raison: null, texte: '' } }
  useRoomStore().seed(payload())
  stub()
})

async function ouvrir(): Promise<ReturnType<typeof useVodStore>> {
  const vod = useVodStore()
  vod.show()
  await flushPromises()
  return vod
}

describe('ouverture', () => {
  it('ne lit le disque qu’à l’ouverture', async () => {
    const vod = useVodStore()

    // Lire le dossier à chaque tic d'horloge coûterait un accès disque par
    // seconde pour une liste qu'on consulte trois fois dans la journée.
    expect(appels).toEqual([])

    vod.show()
    await flushPromises()
    expect(appels.map((appel) => appel.url)).toContain('/control/recordings')
  })

  it('relit le dossier à chaque ouverture', async () => {
    const vod = await ouvrir()
    vod.hide()
    appels = []

    vod.show()
    await flushPromises()

    // Il s'est rempli depuis la dernière fois.
    expect(appels.filter((appel) => appel.url === '/control/recordings')).toHaveLength(1)
  })

  it('coupe le sondage à la fermeture', async () => {
    vi.useFakeTimers()
    const vod = useVodStore()
    vod.show()
    vod.hide()
    appels = []

    vi.advanceTimersByTime(20_000)
    vi.useRealTimers()

    // Sans quoi il survivrait à toutes les ouvertures de la journée.
    expect(appels.filter((appel) => appel.url === '/control/uploads')).toEqual([])
  })
})

describe('ce que la modale dit quand il n’y a rien', () => {
  it('nomme la cause d’un dossier inconnu, plutôt qu’une liste vide', async () => {
    listing = { root: null, entries: [], outils: OUTILS }
    await ouvrir()
    const wrapper = mount(VodDialog, { props: { timeZone: 'Europe/Paris' }, attachTo: document.body })
    await flushPromises()

    // Une liste vide se lirait comme une journée perdue.
    expect(document.body.textContent).toContain('Aucun dossier d’enregistrement connu')
    wrapper.unmount()
  })

  it('signale une machine sans ffprobe, une fois en haut', async () => {
    listing = { root: '/rushes', entries: [RUSH], outils: { ffmpeg: true, ffprobe: false } }
    const vod = await ouvrir()

    // Dit une fois plutôt que découvert bouton par bouton.
    expect(vod.missingTools).toContain('ffprobe introuvable')
    expect(vod.missingTools).toContain('taille et au sidecar')
  })
})

describe('téléversement', () => {
  it('retire les boutons partout quand il n’y a nulle part où envoyer', async () => {
    uploads = {
      ok: true,
      entrees: [],
      verdict: { autorise: false, raison: 'desactive', texte: 'aucun stockage configuré sur le hub' },
    }
    const vod = await ouvrir()
    const wrapper = mount(VodRow, { props: { entry: RUSH as never, timeZone: 'Europe/Paris' } })

    /*
     * Une seule règle pour les deux boutons : séparées, elles avaient divergé,
     * et la régie donnait à lire « on peut tout envoyer, mais rien en
     * particulier » — l'inverse exact de l'état réel.
     */
    expect(vod.blocked).toBe('aucun stockage configuré sur le hub')
    expect(wrapper.find('[data-vod-monter]').exists()).toBe(false)
  })

  it('se tait sur une absence de stockage, et parle d’une attente', async () => {
    uploads = {
      ok: true,
      entrees: [],
      verdict: { autorise: false, raison: 'desactive', texte: 'aucun stockage' },
    }
    let vod = await ouvrir()

    /*
     * « desactive » n'est pas une attente : c'est une fonctionnalité que
     * personne n'a demandée. L'annoncer en ambre toute la journée la ferait
     * passer pour une panne, et userait le bandeau avant le jour où il dit vrai.
     */
    expect(vod.waitReason).toBe(null)

    setActivePinia(createPinia())
    useRoomStore().seed(payload())
    uploads = {
      ok: true,
      entrees: [],
      verdict: { autorise: false, raison: 'conference', texte: 'conférence dans 6 min' },
    }
    vod = await ouvrir()
    expect(vod.waitReason).toBe('Téléversement en attente — conférence dans 6 min.')
  })

  it('ne propose pas de renvoyer un rush déjà chez le stockage', async () => {
    uploads = {
      ok: true,
      entrees: [{ file: RUSH.file, state: 'termine', pourcent: 100, debitOctetsS: null, erreur: null, manuel: false }],
      verdict: { autorise: true, raison: null, texte: '' },
    }
    await ouvrir()
    const wrapper = mount(VodRow, { props: { entry: RUSH as never, timeZone: 'Europe/Paris' } })

    // Un bouton repaierait trois gigaoctets sur le réseau de l'événement au
    // premier clic distrait.
    expect(wrapper.find('[data-vod-monter]').exists()).toBe(false)
    expect(wrapper.find('[data-vod-annuler]').exists()).toBe(false)
    expect(wrapper.text()).toContain('☁')
  })

  it('offre d’annuler ce qui est en vol', async () => {
    uploads = {
      ok: true,
      entrees: [{ file: RUSH.file, state: 'en-cours', pourcent: 42, debitOctetsS: 1000, erreur: null, manuel: true }],
      verdict: { autorise: true, raison: null, texte: '' },
    }
    await ouvrir()
    const wrapper = mount(VodRow, { props: { entry: RUSH as never, timeZone: 'Europe/Paris' } })

    expect(wrapper.text()).toContain('téléversement en cours — 42 %')
    await wrapper.get('[data-vod-annuler]').trigger('click')
    await flushPromises()
    expect(appels.at(-2)?.body).toEqual({ action: 'vod.upload.cancel', file: RUSH.file })
  })

  it('reprend l’erreur du stockage telle quelle', async () => {
    uploads = {
      ok: true,
      entrees: [{ file: RUSH.file, state: 'echoue', pourcent: 12, debitOctetsS: null, erreur: 'AccessDenied', manuel: false }],
      verdict: { autorise: true, raison: null, texte: '' },
    }
    await ouvrir()
    const wrapper = mount(VodRow, { props: { entry: RUSH as never, timeZone: 'Europe/Paris' } })

    // Le seul mot qu'on puisse porter à qui tient le bucket.
    expect(wrapper.text()).toContain('AccessDenied')
  })

  it('met un fichier en file, ou tout ce qui reste', async () => {
    const vod = await ouvrir()
    appels = []

    await vod.upload(RUSH.file)
    await vod.upload(null)

    // `null` vaut « tout ce qui reste » : c'est ce que fait « Tout téléverser ».
    const demandes = appels
      .map((appel) => appel.body as { action?: string; file?: unknown } | null)
      .filter((corps) => corps?.action === 'vod.upload')
    expect(demandes).toEqual([
      { action: 'vod.upload', file: RUSH.file },
      { action: 'vod.upload', file: null },
    ])
  })

  it('prévient qu’une captation en cours retient le départ', async () => {
    useRoomStore().payload!.state.recording = true
    const vod = await ouvrir()

    await vod.upload(RUSH.file)

    // Le seul cas où le régulateur refuse *malgré* la demande manuelle : on ne
    // lit pas le disque sur lequel un master s'écrit.
    expect(useToast().notices.value.at(-1)?.text).toContain('départ à l’arrêt de la captation')
  })
})

describe('verdict de la régie', () => {
  it('pose le verdict, puis le retire au même bouton', async () => {
    const vod = await ouvrir()

    await vod.verdict(RUSH.file, 'ok')
    expect(appels.at(-2)?.body).toEqual({ action: 'vod.verdict', file: RUSH.file, status: 'ok' })

    listing = {
      root: '/rushes',
      entries: [{ ...RUSH, check: { status: 'ok', at: '', by: 'operateur', reasons: [], probe: null } }],
      outils: OUTILS,
    }
    await vod.loadListing()
    await vod.verdict(RUSH.file, 'ok')

    // Sans le retrait, une fausse manœuvre resterait à l'écran sans moyen de la
    // reprendre — et se relirait au montage comme une information.
    expect(appels.at(-2)?.body).toEqual({ action: 'vod.verdict', file: RUSH.file, status: null })
  })
})

describe('contrôle de tout le dossier', () => {
  it('y va en série, un fichier après l’autre', async () => {
    listing = {
      root: '/rushes',
      entries: [RUSH, { ...RUSH, file: 'b.mkv' }, { ...RUSH, file: 'c.mkv' }],
      outils: OUTILS,
    }
    const vod = await ouvrir()
    appels = []

    await vod.checkAll()

    /*
     * ffprobe lit réellement les fichiers : lancer six lectures de rushes de
     * deux heures sur le disque qui enregistre est exactement ce qu'on ne veut
     * pas pendant une conférence.
     */
    const inspections = appels.filter(
      (appel) => (appel.body as { action?: string } | null)?.action === 'vod.inspect',
    )
    expect(inspections.map((appel) => (appel.body as { file: string }).file)).toEqual([
      RUSH.file,
      'b.mkv',
      'c.mkv',
    ])
  })

  it('résume en un mot plutôt qu’en douze', async () => {
    listing = {
      root: '/rushes',
      entries: [
        { ...RUSH, check: { status: 'ok', at: '', by: 'auto', reasons: [], probe: null } },
        { ...RUSH, file: 'b.mkv', check: { status: 'illisible', at: '', by: 'auto', reasons: ['vide'], probe: null } },
      ],
      outils: OUTILS,
    }
    const vod = await ouvrir()

    await vod.checkAll()

    // Douze messages à la suite ne disent rien de plus que le compte affiché
    // en haut.
    expect(useToast().notices.value).toHaveLength(1)
    expect(useToast().notices.value[0]?.text).toBe('1 enregistrement(s) à revoir')
  })
})

describe('ligne d’un rush', () => {
  it('lit d’un coup d’œil quand, combien, et ce qui manque déjà', async () => {
    await ouvrir()
    const wrapper = mount(VodRow, {
      props: { entry: { ...RUSH, enEcriture: true } as never, timeZone: 'Europe/Paris' },
    })

    const texte = wrapper.text()
    expect(texte).toContain('1 marqueur')
    expect(texte).toContain('45:00')
    expect(texte).toContain('4,2 Go')
    expect(texte).toContain('encore en écriture')
  })

  it('dit le sidecar absent, qui est justement le cas qu’on cherche', async () => {
    await ouvrir()
    const wrapper = mount(VodRow, {
      props: { entry: { ...RUSH, sidecar: null } as never, timeZone: 'Europe/Paris' },
    })

    // OBS tué en plein arrêt : le rush est là, ce qui le décrit ne l'est pas.
    expect(wrapper.text()).toContain('sidecar absent')
    expect(wrapper.text()).toContain('Titre inconnu')
  })

  it('explique un badge rouge, plutôt que de le laisser nu', async () => {
    await ouvrir()
    const wrapper = mount(VodRow, {
      props: {
        entry: {
          ...RUSH,
          check: { status: 'illisible', at: '', by: 'auto', reasons: ['conteneur illisible'], probe: null },
        } as never,
        timeZone: 'Europe/Paris',
      },
    })

    expect(wrapper.text()).toContain('Illisible')
    expect(wrapper.text()).toContain('conteneur illisible')
  })
})
