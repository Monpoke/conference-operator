import type { EntreeVod, EtatTeleversementVu, VodListe, VueTeleversements } from '@cloudnord/contract'
import { useToast } from '@cloudnord/components'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useActionsStore } from './actions.js'
import { useRoomStore } from './room.js'

/**
 * Contrôle des rushes.
 *
 * La question à laquelle cette modale répond est celle qu'on se pose au
 * démontage : « est-ce qu'on a bien tout ? » Le chronomètre de la régie a dit
 * qu'on enregistrait ; il ne dit pas qu'OBS écrivait vraiment quelque chose
 * d'exploitable. Entre les deux, il y a un disque plein, un encodeur qui a
 * lâché, une carte d'acquisition débranchée — et personne ne s'en aperçoit
 * avant le montage, quand la salle n'existe plus.
 *
 * Rien n'est chargé tant qu'on n'ouvre pas : lire le dossier des captations à
 * chaque tic d'horloge coûterait un accès disque par seconde pour une liste
 * qu'on consulte trois fois dans la journée.
 */

/**
 * Sondage tant que la modale est ouverte, et lui seul.
 *
 * Trois secondes : assez pour qu'un pourcentage avance sous les yeux, assez peu
 * pour qu'une salle dont la modale est fermée — c'est-à-dire toute la journée —
 * ne génère aucun trafic.
 */
export const UPLOADS_POLL_MS = 3000

/** Vingt secondes : assez pour entendre le son et voir le cadrage, pas plus. */
export const EXTRACT_MS = 20_000

export const VERDICT_BADGES: Record<string, [string, string]> = {
  ok: ['Exploitable', 'border-ok/50 text-ok'],
  suspect: ['À revoir', 'border-attention/50 text-attention'],
  illisible: ['Illisible', 'border-alerte/60 text-alerte'],
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
  const listing = ref<VodListe | null>(null)
  const uploads = ref<VueTeleversements | null>(null)
  /** Rush déplié pour aperçu, et l'endroit du fichier qu'on regarde. */
  const preview = ref<{ file: string; at: number } | null>(null)
  const checking = ref(false)
  const progress = ref('')

  let timer: ReturnType<typeof setInterval> | null = null

  async function loadListing(): Promise<void> {
    try {
      const response = await fetch('/control/recordings')
      const body = (await response.json()) as VodListe & { ok?: boolean; message?: string }
      listing.value = { root: body.root ?? null, entries: body.entries ?? [], outils: body.outils }
      if (body.ok === false && body.message != null) toast.fail(body.message)
    } catch {
      listing.value = { root: null, entries: [], outils: null as never }
      toast.fail('Le service local ne répond pas')
    }
  }

  /**
   * Téléversements en cours, sondés plutôt que poussés.
   *
   * Même choix que la charge du poste : un pourcentage qui avance placé dans le
   * flux d'état republierait tout le diagnostic à chaque part. Ici, seule une
   * modale ouverte interroge.
   */
  async function loadUploads(): Promise<void> {
    try {
      const response = await fetch('/control/uploads')
      const body = (await response.json()) as VueTeleversements & { ok?: boolean }
      uploads.value = body.ok === false ? null : body
    } catch {
      uploads.value = null
    }
  }

  /**
   * Ce qui empêche tout téléversement, individuel comme global — ou rien.
   *
   * Une seule règle pour les deux boutons. Séparées, elles avaient divergé : les
   * lignes n'offraient plus de ⬆ faute de destination, pendant que « Tout
   * téléverser » restait actif en en-tête. La régie donnait donc à lire « on
   * peut tout envoyer, mais rien en particulier » — l'inverse exact de l'état
   * réel, et la seule explication disponible était de cliquer.
   *
   * Ne couvre que l'indisponibilité de fond. Une attente passagère — captation
   * en cours, débit plafonné — laisse les boutons : la demande est mise en file,
   * et le bandeau au-dessus dit ce qu'on attend.
   */
  const blocked = computed<string | null>(() => {
    if (uploads.value == null) return 'État des téléversements indisponible'
    if (uploads.value.verdict?.raison === 'desactive') {
      return uploads.value.verdict.texte ?? 'aucun stockage configuré sur le hub'
    }
    return null
  })

  /**
   * Rien à dire quand tout va, ni quand il n'y a rien à faire aller.
   *
   * « desactive » n'est pas une attente : c'est un hub sans stockage, donc une
   * fonctionnalité que personne n'a demandée. L'annoncer en ambre à chaque
   * ouverture de la modale, toute la journée, la ferait passer pour une panne —
   * et userait le bandeau avant le jour où il dit vrai.
   */
  const waitReason = computed<string | null>(() => {
    const verdict = uploads.value?.verdict
    if (verdict == null || verdict.autorise || verdict.raison === 'desactive') return null
    return `Téléversement en attente — ${verdict.texte}.`
  })

  /** État de montée d'un fichier, ou nul s'il n'a jamais été mis en file. */
  function uploadOf(file: string): EtatTeleversementVu | null {
    return (uploads.value?.entrees ?? []).find((entry) => entry.file === file) ?? null
  }

  function show(): void {
    open.value = true
    // Relu à chaque ouverture : le dossier s'est rempli depuis la dernière fois.
    listing.value = null
    preview.value = null
    uploads.value = null
    void loadListing()
    void loadUploads()
    // Coupé à la fermeture, sans quoi il survivrait à toutes les ouvertures de
    // la journée.
    timer ??= setInterval(() => void loadUploads(), UPLOADS_POLL_MS)
  }

  function hide(): void {
    open.value = false
    if (timer != null) clearInterval(timer)
    timer = null
  }

  /** Déplie l'aperçu d'un rush, ou le referme si c'est déjà le sien. */
  function togglePreview(file: string): void {
    preview.value = preview.value?.file === file ? null : { file, at: 0 }
  }

  async function inspect(file: string): Promise<void> {
    await actions.act({ action: 'vod.inspect', file })
    await loadListing()
  }

  /**
   * Le même bouton pose et retire le verdict.
   *
   * Sans le retrait, une fausse manœuvre resterait à l'écran sans moyen de la
   * reprendre — et c'est le genre de marque qu'on relit au montage comme une
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
   * Contrôle de tout le dossier, un fichier après l'autre.
   *
   * En série, et pas en parallèle : ffprobe lit réellement les fichiers, et
   * lancer six lectures de rushes de deux heures sur le disque qui enregistre
   * est exactement ce qu'on ne veut pas pendant une conférence. Sans avis par
   * fichier non plus — douze messages à la suite ne disent rien de plus que le
   * compte affiché en haut.
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
   * Met un rush en file, ou tout ce qui reste.
   *
   * Aucune fenêtre de confirmation, et surtout pas une native : elle bloque la
   * boucle de rendu de la page, donc le chronomètre et le flux des salles, en
   * pleine conférence. Le geste n'est de toute façon pas destructif — il met en
   * file, il ne lit rien tout de suite.
   *
   * Le seul cas qui mérite un mot est la captation en cours : c'est le seul où
   * le régulateur refusera *malgré* la demande manuelle, parce qu'on ne lit pas
   * le disque sur lequel un master s'écrit.
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
   * Ce dont la machine ne dispose pas, dit une fois en haut plutôt que découvert
   * bouton par bouton.
   */
  const missingTools = computed<string | null>(() => {
    const tools = listing.value?.outils
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

  function entryOf(file: string): EntreeVod | null {
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
    entryOf,
    togglePreview,
    inspect,
    verdict,
    checkAll,
    upload,
    cancelUpload,
  }
})
