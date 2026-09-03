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
 * Le contrôle des rushes, et la question du démontage.
 *
 * « Est-ce qu'on a bien tout ? » Le chronomètre de la régie a dit qu'on
 * enregistrait ; il ne dit pas qu'OBS écrivait quelque chose d'exploitable.
 * Entre les deux : un disque plein, un encodeur qui a lâché, une carte
 * d'acquisition débranchée — et personne ne s'en aperçoit avant le editing,
 * quand la salle n'existe plus.
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
  listing = { root: '/rushes', entries: [RUSH], tools: OUTILS }
  uploads = { ok: true, entries: [], verdict: { allowed: true, reason: null, text: '' } }
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
    listing = { root: null, entries: [], tools: OUTILS }
    await ouvrir()
    const wrapper = mount(VodDialog, { props: { timeZone: 'Europe/Paris' }, attachTo: document.body })
    await flushPromises()

    // Une liste vide se lirait comme une journée perdue.
    expect(document.body.textContent).toContain('Aucun dossier d’enregistrement connu')
    wrapper.unmount()
  })

  it('signale une machine sans ffprobe, une fois en haut', async () => {
    listing = { root: '/rushes', entries: [RUSH], tools: { ffmpeg: true, ffprobe: false } }
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
      entries: [],
      verdict: { allowed: false, reason: 'sans-stockage', text: 'aucun stockage configuré sur le hub' },
    }
    const vod = await ouvrir()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    /*
     * Une seule règle pour les deux boutons : séparées, elles avaient divergé,
     * et la régie donnait à lire « on peut tout envoyer, mais rien en
     * particulier » — l'inverse exact de l'état réel.
     */
    expect(vod.blocked).toBe('aucun stockage configuré sur le hub')
    expect(wrapper.find('[data-vod-monter]').exists()).toBe(false)
  })

  it('garde les boutons quand seul l’automatique est éteint', async () => {
    /*
     * Le réglage **par défaut** du hub : rien ne part sans qu'on l'ait demandé.
     * Les deux motifs partageaient un code, et la régie retirait ses boutons
     * ici comme sur un hub sans stockage — une installation parfaitement
     * configurée n'offrait alors aucun moyen d'envoyer quoi que ce soit, alors
     * que le régulateur, lui, acceptait déjà les demandes manuelles.
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
    const vod = await ouvrir()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    expect(vod.blocked).toBe(null)
    expect(vod.manualOnly).toBe(true)
    expect(wrapper.find('[data-vod-monter]').exists()).toBe(true)
    // Pas d'ambre : c'est un réglage assumé, pas une attente.
    expect(vod.waitReason).toBe(null)
  })

  it('dit en haut que les envois se font à la main', async () => {
    uploads = {
      ok: true,
      entries: [],
      verdict: {
        allowed: false,
        reason: 'auto-desactive',
        text: 'téléversement automatique désactivé',
      },
    }
    await ouvrir()
    const wrapper = mount(VodDialog, { props: { timeZone: 'Europe/Paris' }, attachTo: document.body })
    await flushPromises()

    // Sans quoi l'opérateur qui vient d'en monter un à la main se demande
    // pourquoi les suivants ne partent pas seuls.
    const ligne = document.body.querySelector('[data-role="vod-manual"]')
    expect(ligne?.textContent).toContain('les envois se font à la main')
    // « Tout téléverser » reste armé : la même règle que les ⬆ des lignes.
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
    let vod = await ouvrir()

    /*
     * « sans-stockage » n'est pas une attente : c'est une fonctionnalité que
     * personne n'a demandée. L'annoncer en ambre toute la journée la ferait
     * passer pour une panne, et userait le bandeau avant le jour où il dit vrai.
     */
    expect(vod.waitReason).toBe(null)

    setActivePinia(createPinia())
    useRoomStore().seed(payload())
    uploads = {
      ok: true,
      entries: [],
      verdict: { allowed: false, reason: 'conference', text: 'conférence dans 6 min' },
    }
    vod = await ouvrir()
    expect(vod.waitReason).toBe('Téléversement en attente — conférence dans 6 min.')
  })

  it('ne propose pas de renvoyer un rush déjà chez le stockage', async () => {
    uploads = {
      ok: true,
      entries: [{ file: RUSH.file, state: 'termine', percent: 100, remainingBytes: 0, debitOctetsS: null, error: null, manual: false }],
      verdict: { allowed: true, reason: null, text: '' },
    }
    await ouvrir()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    // Un bouton repaierait trois gigaoctets sur le réseau de l'événement au
    // premier clic distrait.
    expect(wrapper.find('[data-vod-monter]').exists()).toBe(false)
    expect(wrapper.find('[data-vod-annuler]').exists()).toBe(false)
    expect(wrapper.text()).toContain('☁')
  })

  it('offre d’annuler ce qui est en vol, sans perdre le témoin', async () => {
    uploads = {
      ok: true,
      entries: [{ file: RUSH.file, state: 'en-cours', percent: 42, remainingBytes: 2_400_000_000, debitOctetsS: 12_000_000, error: null, manual: true }],
      verdict: { allowed: true, reason: null, text: '' },
    }
    await ouvrir()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    expect(wrapper.text()).toContain('téléversement en cours — 42 %')

    /*
     * Le ⬆ laissait la place à « Annuler », et la ligne perdait d'un coup le
     * seul repère qui disait où en était ce fichier-là : sur une modale qui en
     * aligne quinze, il fallait relire le détail en petit pour retrouver celui
     * qui montait.
     */
    const temoin = wrapper.get('[data-vod-progression]')
    expect(temoin.attributes('title')).toContain('42 %')
    expect(temoin.get('span').classes()).toContain('animate-spin')

    await wrapper.get('[data-vod-annuler]').trigger('click')
    await flushPromises()
    expect(appels.at(-2)?.body).toEqual({ action: 'vod.upload.cancel', file: RUSH.file })
  })

  it('bat au lieu de tourner tant que rien ne part encore', async () => {
    // Un anneau qui tourne sur une file d'attente ferait croire à une montée
    // qui n'avance pas : ça tourne quand des octets partent, ça bat sinon.
    uploads = {
      ok: true,
      entries: [{ file: RUSH.file, state: 'attente', percent: 0, remainingBytes: 4_200_000_000, debitOctetsS: null, error: null, manual: true }],
      verdict: { allowed: false, reason: 'conference', text: 'conférence en cours' },
    }
    await ouvrir()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    const temoin = wrapper.get('[data-vod-progression]')
    expect(temoin.attributes('title')).toContain('En file')
    expect(temoin.get('span').classes()).toContain('animate-pulse')
    expect(temoin.get('span').classes()).not.toContain('animate-spin')
    // Annuler reste offert : une montée qui n'a pas commencé s'abandonne aussi.
    expect(wrapper.find('[data-vod-annuler]').exists()).toBe(true)
  })

  it('dit le temps qu’il reste, que le pourcentage laisse entier', async () => {
    /*
     * La question du démontage n'est pas « où en est-il ? » mais « est-ce que
     * je peux débrancher ce disque avant de partir ? ». 60 % sur un rush de
     * quatre gigas, c'est deux minutes ou quarante, selon un débit que
     * l'opérateur n'a aucune raison de connaître.
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
    await ouvrir()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    // Soixante méga-octets à un méga-octet par seconde.
    expect(wrapper.text()).toContain('téléversement en cours — 40 % · reste 1 min')
    // « environ » sur le témoin : ce qui vaut ce que vaut le réseau se lit
    // comme une estimation, sans quoi on range le disque sur la foi du chiffre.
    expect(wrapper.get('[data-vod-progression]').attributes('title')).toContain(
      'reste environ 1 min',
    )
  })

  it('compte avec le plafond du hub, pas avec la vitesse d’une part', async () => {
    /*
     * Le débit remonté est celui de l'envoi d'une part, mesuré *avant* la pause
     * qui applique le plafond. Sans le plafond dans le calcul, un uplink dix
     * fois plus rapide que le réglage annoncerait dix fois moins de temps — et
     * une estimation trop courte est pire que pas d'estimation du tout.
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
    const vod = await ouvrir()

    expect(vod.etaOf(RUSH.file)).toBe(60_000)
  })

  it('lisse le débit, pour que le chiffre ne danse pas', async () => {
    /*
     * `debitOctetsS` est le débit de la dernière part, mesurée seule : sur le
     * réseau d'un événement il varie du simple au triple d'une part à l'autre.
     * Brut, le temps restant sauterait de « 1 min » à « 10 min » toutes les
     * trois secondes — un chiffre qui danse, on cesse de le regarder.
     */
    const ligne = (debitOctetsS: number): Record<string, unknown> => ({
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

    uploads = ligne(1_000_000)
    const vod = await ouvrir()

    // Une part malchanceuse : le débit s'effondre d'un coup.
    uploads = ligne(100_000)
    await vod.loadUploads()

    // Un tiers de poids au dernier relevé : 700 ko/s, et non les 100 ko/s qui
    // auraient annoncé dix minutes.
    expect(vod.etaOf(RUSH.file)).toBe(Math.round((60_000_000 / 700_000) * 1000))
  })

  it('n’annonce aucun temps tant que rien n’est parti', async () => {
    // « Ça y est dans un instant » sur une file d'attente qui n'a pas commencé
    // serait une promesse inventée : rien n'est parti, rien n'a été mesuré.
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
    const vod = await ouvrir()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    expect(vod.etaOf(RUSH.file)).toBeNull()
    expect(wrapper.text()).not.toContain('reste')
  })

  it('n’annule pas au clic sur le témoin', async () => {
    uploads = {
      ok: true,
      entries: [{ file: RUSH.file, state: 'en-cours', percent: 80, remainingBytes: 840_000_000, debitOctetsS: 12_000_000, error: null, manual: true }],
      verdict: { allowed: true, reason: null, text: '' },
    }
    await ouvrir()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })
    appels = []

    await wrapper.get('[data-vod-progression]').trigger('click')
    await flushPromises()

    // Trois gigaoctets déjà montés ne se perdent pas sur un doigt distrait :
    // « Annuler » est un bouton nommé, le témoin n'en est pas un.
    expect(appels).toEqual([])
  })

  it('donne la même case aux quatre icônes, et réserve celle du téléversement', async () => {
    /*
     * Rien ne s'alignait d'une ligne à l'autre, pour deux raisons cumulées.
     *
     * Chaque bouton était large de son glyphe : 👁 et ⬆ sont des emoji, ✓ et ✕
     * des caractères de texte bien plus étroits. Et la colonne du téléversement
     * portait tantôt un ⬆, tantôt un ☁, tantôt un témoin **et** un bouton
     * « Annuler » — trois largeurs, donc un ✓ et un ✕ qui ne tombaient au même
     * endroit sur aucune ligne.
     */
    uploads = {
      ok: true,
      entries: [],
      verdict: { allowed: true, reason: null, text: '' },
    }
    await ouvrir()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    const icones = ['data-vod-apercu', 'data-vod-monter', 'data-vod-verdict-ok', 'data-vod-verdict-ko']
    for (const marque of icones) {
      const bouton = wrapper.get(`[${marque}]`)
      expect(bouton.classes()).toContain('w-9')
      // `px-0` retire le rembourrage du bouton, qui rendait la largeur
      // dépendante du contenu — c'est lui que `tailwind-merge` doit emporter.
      expect(bouton.classes()).toContain('px-0')
      expect(bouton.classes()).not.toContain('px-3')
    }

    // La colonne réserve la place du cas le plus large sur toutes les lignes,
    // et pousse son contenu à droite : ⬆, ☁ et « Annuler » partagent le bord
    // qui touche le ✓.
    const colonne = wrapper.get('[data-vod-monter]').element.parentElement
    expect(colonne?.className).toContain('w-[6.75rem]')
    expect(colonne?.className).toContain('justify-end')
  })

  it('garde la colonne à la même largeur pendant la montée', async () => {
    uploads = {
      ok: true,
      entries: [{ file: RUSH.file, state: 'en-cours', percent: 42, remainingBytes: 2_400_000_000, debitOctetsS: 12_000_000, error: null, manual: true }],
      verdict: { allowed: true, reason: null, text: '' },
    }
    await ouvrir()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    // Le témoin et « Annuler » tiennent dans la même case que le seul ⬆ de la
    // ligne d'à côté : sans quoi le ✓ et le ✕ sautent d'une ligne à l'autre.
    const colonne = wrapper.get('[data-vod-annuler]').element.parentElement
    expect(colonne?.className).toContain('w-[6.75rem]')
    expect(wrapper.get('[data-vod-progression]').element.parentElement).toBe(colonne)
  })

  it('donne au ☁ la largeur d’un bouton, faute d’en être un', async () => {
    // Il n'est pas cliquable — repayer trois gigaoctets au premier clic distrait
    // est ce qu'on évite — mais il occupe la même case, sinon la ligne se décale.
    uploads = {
      ok: true,
      entries: [{ file: RUSH.file, state: 'termine', percent: 100, remainingBytes: 0, debitOctetsS: null, error: null, manual: false }],
      verdict: { allowed: true, reason: null, text: '' },
    }
    await ouvrir()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    const nuage = wrapper.findAll('span').find((span) => span.text() === '☁')
    expect(nuage?.classes()).toContain('w-9')
  })

  it('aligne les noms de fichier, quel que soit le verdict', async () => {
    // « Non vérifié », « Exploitable », « À revoir » et « Illisible » n'ont pas
    // la même longueur : le nom commençait à quatre abscisses différentes.
    await ouvrir()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

    expect(wrapper.get('[data-role="vod-badge"]').classes()).toContain('w-24')
  })

  it('reprend l’erreur du stockage telle quelle', async () => {
    uploads = {
      ok: true,
      entries: [{ file: RUSH.file, state: 'echoue', percent: 12, remainingBytes: 3_696_000_000, debitOctetsS: null, error: 'AccessDenied', manual: false }],
      verdict: { allowed: true, reason: null, text: '' },
    }
    await ouvrir()
    const wrapper = mount(VodRow, { props: { entry: RUSH, timeZone: 'Europe/Paris' } })

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
      tools: OUTILS,
    }
    await vod.loadListing()
    await vod.verdict(RUSH.file, 'ok')

    // Sans le retrait, une fausse manœuvre resterait à l'écran sans moyen de la
    // reprendre — et se relirait au editing comme une information.
    expect(appels.at(-2)?.body).toEqual({ action: 'vod.verdict', file: RUSH.file, status: null })
  })
})

describe('contrôle de tout le dossier', () => {
  it('y va en série, un fichier après l’autre', async () => {
    listing = {
      root: '/rushes',
      entries: [RUSH, { ...RUSH, file: 'b.mkv' }, { ...RUSH, file: 'c.mkv' }],
      tools: OUTILS,
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
      tools: OUTILS,
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
      props: { entry: { ...RUSH, beingWritten: true }, timeZone: 'Europe/Paris' },
    })

    const texte = wrapper.text()
    expect(texte).toContain('1 marqueur')
    expect(texte).toContain('45:00')
    expect(texte).toContain('4,2 Go')
    expect(texte).toContain('encore en écriture')
    // Aucun repère sur ce rush : rien n'est dit. La prise est finie, on ne peut
    // plus en poser, et un reproche sans remède n'apprend rien.
    expect(texte).not.toContain('rognage')
  })

  it('dit ce que le editing coupera, tant que le fichier est encore là', async () => {
    await ouvrir()
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
    // Les deux repères ne sont pas des chapitres : seul « Questions » en est un.
    expect(texte).toContain('1 marqueur')
  })

  it('marque d’un « ? » le repère qui manque, plutôt que de se taire', async () => {
    await ouvrir()
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
    // pendant que la salle est encore montée vaut mieux que de le découvrir
    // sur la vidéo publiée.
    expect(wrapper.text()).toContain('rognage 00:52 → ?')
  })

  it('dit le sidecar absent, qui est justement le cas qu’on cherche', async () => {
    await ouvrir()
    const wrapper = mount(VodRow, {
      props: { entry: { ...RUSH, sidecar: null }, timeZone: 'Europe/Paris' },
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
        },
        timeZone: 'Europe/Paris',
      },
    })

    expect(wrapper.text()).toContain('Illisible')
    expect(wrapper.text()).toContain('conteneur illisible')
  })
})
