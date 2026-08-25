import { createReadStream } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import type { Sidecar } from './recording.js'

/**
 * Ce que la régie sait dire d'un fichier produit dans la journée.
 *
 * `illisible` est un constat technique — le conteneur ne s'ouvre pas, la piste
 * vidéo manque, le fichier est vide ; `suspect` veut dire « regardez-le
 * vous-même » : il s'ouvre, mais quelque chose ne colle pas avec ce que la
 * régie croyait enregistrer. Les deux méritent d'être vus avant de démonter
 * la salle, pas la veille du montage.
 */
export type VerdictVod = 'ok' | 'suspect' | 'illisible'

/** Ce que ffprobe a lu du fichier. Absent quand l'outil n'est pas installé. */
export interface SondageVod {
  /**
   * ffprobe a reconnu le conteneur.
   *
   * Faux, tout le reste est nul — et il faut le dire ainsi : « aucune piste
   * vidéo » laisse croire à un fichier valide amputé de son image, alors que
   * c'est le conteneur entier qui ne s'ouvre pas. Les deux ne se réparent pas
   * de la même façon.
   */
  ouvert: boolean
  durationMs: number | null
  video: { codec: string; width: number; height: number; fps: number | null } | null
  audio: { codec: string; channels: number } | null
  bitrateKbps: number | null
}

export interface ControleVod {
  status: VerdictVod
  /** Instant du contrôle : un verdict d'il y a trois heures ne vaut plus rien. */
  at: string
  /** `auto` = la vérification technique ; `operateur` = quelqu'un a ouvert le fichier. */
  by: 'auto' | 'operateur'
  /** Ce qui a motivé le verdict, en clair : un badge rouge sans raison ne sert personne. */
  reasons: string[]
  probe: SondageVod | null
}

export interface EntreeVod {
  /** Chemin relatif à la racine, séparateurs normalisés — c'est aussi la clé. */
  file: string
  sizeBytes: number
  modifiedAtMs: number
  /**
   * Le fichier a bougé il y a quelques secondes : la prise est probablement
   * encore en cours. Le contrôler maintenant dirait « tronqué » d'un
   * enregistrement qui se porte très bien.
   */
  enEcriture: boolean
  sidecar: Sidecar | null
  check: ControleVod | null
}

/** Conteneurs qu'OBS sait écrire. Le reste du dossier ne nous regarde pas. */
const EXTENSIONS = new Set(['.mkv', '.mp4', '.mov', '.flv', '.ts', '.m4v', '.webm', '.mpegts'])

/**
 * Les verdicts vivent dans un fichier à part, pas dans les sidecars.
 *
 * Le sidecar est ce que la chaîne de montage consomme, et il décrit la
 * conférence, pas la relecture qu'on en a faite. Surtout : un rush dont le
 * sidecar n'a jamais été écrit — OBS tué en plein arrêt, précisément le cas
 * qu'on cherche — est justement celui qu'il faut pouvoir marquer.
 */
const FICHIER_CONTROLES = '.controles-vod.json'

/** Le fichier vient d'être touché : on ne juge pas une prise en cours. */
const FENETRE_ECRITURE_MS = 30_000

/** Profondeur de balayage : OBS écrit à plat, un dossier daté reste possible. */
const PROFONDEUR_MAX = 2

export interface VodFs {
  readdir(path: string): Promise<{ name: string; isDirectory: boolean }[]>
  stat(path: string): Promise<{ size: number; mtimeMs: number } | null>
  readFile(path: string): Promise<string | null>
  writeFile(path: string, contents: string): Promise<void>
}

export interface VodIndexDeps {
  /** Racine des enregistrements. Sans elle, il n'y a rien à lister. */
  root: string
  fs: VodFs
  now: () => number
  /**
   * Lecture technique du conteneur. `null` = pas d'outil disponible, le
   * contrôle se rabat alors sur ce que le disque et le sidecar racontent.
   */
  probe?: (path: string) => Promise<SondageVod | null>
  onLog?: (level: 'info' | 'warn' | 'error', message: string, context?: unknown) => void
}

/**
 * Liste les fichiers produits sous la racine, du plus récent au plus ancien.
 *
 * Purement descriptif : rien n'est ouvert, rien n'est sondé. Ouvrir la modale
 * ne doit pas lancer une demi-douzaine de ffprobe sur des rushes de deux heures
 * pendant qu'une conférence tourne.
 */
export async function listerEnregistrements(deps: VodIndexDeps): Promise<EntreeVod[]> {
  const racine = resolve(deps.root)
  const controles = await lireControles(deps, racine)
  const entrees: EntreeVod[] = []

  const balayer = async (dossier: string, profondeur: number): Promise<void> => {
    let contenu: { name: string; isDirectory: boolean }[]
    try {
      contenu = await deps.fs.readdir(dossier)
    } catch (cause) {
      deps.onLog?.('warn', 'dossier des enregistrements illisible', {
        path: dossier,
        message: (cause as Error).message,
      })
      return
    }

    for (const element of contenu) {
      const chemin = join(dossier, element.name)
      if (element.isDirectory) {
        if (profondeur < PROFONDEUR_MAX) await balayer(chemin, profondeur + 1)
        continue
      }
      if (!EXTENSIONS.has(extname(element.name).toLowerCase())) continue

      const stat = await deps.fs.stat(chemin)
      if (stat == null) continue

      const cle = normaliser(relative(racine, chemin))
      entrees.push({
        file: cle,
        sizeBytes: stat.size,
        modifiedAtMs: stat.mtimeMs,
        enEcriture: deps.now() - stat.mtimeMs < FENETRE_ECRITURE_MS,
        sidecar: await lireSidecar(deps, chemin),
        check: controles[cle] ?? null,
      })
    }
  }

  await balayer(racine, 1)
  entrees.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)
  return entrees
}

/**
 * Contrôle un fichier et retient le verdict.
 *
 * L'ordre des règles compte : ce qui interdit d'exploiter le fichier passe
 * avant ce qui le rend seulement douteux, et la première raison affichée est
 * celle qui explique le badge.
 */
export async function inspecterEnregistrement(
  deps: VodIndexDeps,
  file: string,
): Promise<ControleVod> {
  const racine = resolve(deps.root)
  const chemin = cheminSur(racine, file)
  const stat = await deps.fs.stat(chemin)
  const at = new Date(deps.now()).toISOString()

  if (stat == null || stat.size === 0) {
    const controle: ControleVod = {
      status: 'illisible',
      at,
      by: 'auto',
      reasons: [stat == null ? 'fichier absent du disque' : 'fichier vide : OBS n’a rien écrit'],
      probe: null,
    }
    await retenir(deps, racine, file, controle)
    return controle
  }

  const raisons: string[] = []
  let statut: VerdictVod = 'ok'
  const abaisser = (vers: VerdictVod, raison: string): void => {
    raisons.push(raison)
    if (vers === 'illisible' || statut === 'ok') statut = vers
  }

  if (deps.now() - stat.mtimeMs < FENETRE_ECRITURE_MS) {
    abaisser('suspect', 'fichier encore en écriture : à recontrôler une fois la prise arrêtée')
  }

  const sidecar = await lireSidecar(deps, chemin)
  if (sidecar == null) {
    abaisser('suspect', 'sidecar absent : titre, intervenants et marqueurs manquent au montage')
  }

  const probe = deps.probe == null ? null : await deps.probe(chemin)
  if (probe == null) {
    raisons.push('sonde ffprobe indisponible : contrôle limité à la taille et au sidecar')
  } else if (!probe.ouvert) {
    // Un seul motif, et le bon : détailler les pistes d'un fichier que ffprobe
    // refuse d'ouvrir enverrait chercher au mauvais endroit.
    abaisser('illisible', 'conteneur illisible : ffprobe ne reconnaît pas ce fichier')
  } else {
    if (probe.video == null) abaisser('illisible', 'aucune piste vidéo dans le conteneur')
    if (probe.audio == null) abaisser('illisible', 'aucune piste audio : la VOD serait muette')
    if (probe.durationMs == null) {
      abaisser('illisible', 'durée illisible : conteneur tronqué, OBS a probablement été tué')
    } else if (probe.durationMs < 5_000) {
      abaisser('suspect', 'moins de cinq secondes de contenu')
    }
  }

  // Ce que le chronomètre de la régie disait, contre ce que le fichier contient.
  // L'écart est le symptôme d'un arrêt brutal, et il ne se voit nulle part ailleurs.
  const attendu = sidecar?.durationMs ?? null
  const reelle = probe?.durationMs ?? null
  if (attendu != null && reelle != null && attendu > 60_000 && reelle < attendu * 0.9) {
    abaisser(
      'suspect',
      `${minutes(reelle)} enregistrées pour ${minutes(attendu)} chronométrées : fin manquante`,
    )
  }

  const duree = reelle ?? attendu
  const debit = duree != null && duree > 1_000 ? Math.round((stat.size * 8) / duree) : null
  // Sur un conteneur illisible, le « débit » ne mesure rien : c'est la taille du
  // fichier divisée par une durée qui vient d'ailleurs.
  if (debit != null && debit < 200 && probe?.ouvert !== false) {
    abaisser('suspect', `débit moyen de ${debit} kb/s : image probablement inexploitable`)
  }

  if (statut === 'ok' && raisons.length === 0) {
    raisons.push(
      probe == null
        ? 'taille et sidecar cohérents'
        : `${probe.video?.width ?? '?'}×${probe.video?.height ?? '?'}, ${probe.audio?.channels ?? '?'} canal(aux), ${minutes(reelle ?? 0)}`,
    )
  }

  const controle: ControleVod = {
    status: statut,
    at,
    by: 'auto',
    reasons: raisons,
    probe: probe == null ? null : { ...probe, bitrateKbps: probe.bitrateKbps ?? debit },
  }
  await retenir(deps, racine, file, controle)
  return controle
}

/**
 * Verdict posé à la main.
 *
 * Le dernier mot revient à qui a ouvert le fichier : aucune sonde ne dit si la
 * caméra était sur le mauvais plan ou le micro dans la poche. `null` efface le
 * contrôle et remet la ligne à vérifier.
 */
export async function poserVerdict(
  deps: VodIndexDeps,
  file: string,
  status: VerdictVod | null,
): Promise<ControleVod | null> {
  const racine = resolve(deps.root)
  cheminSur(racine, file)
  if (status == null) {
    await retenir(deps, racine, file, null)
    return null
  }

  const precedent = (await lireControles(deps, racine))[file] ?? null
  const controle: ControleVod = {
    status,
    at: new Date(deps.now()).toISOString(),
    by: 'operateur',
    reasons: [status === 'ok' ? 'relu en régie' : 'signalé en régie'],
    // Ce que la sonde avait lu reste affiché : le verdict humain le complète,
    // il ne l'efface pas.
    probe: precedent?.probe ?? null,
  }
  await retenir(deps, racine, file, controle)
  return controle
}

/** Écrit le verdict dans l'index. `null` le retire. */
async function retenir(
  deps: VodIndexDeps,
  racine: string,
  file: string,
  controle: ControleVod | null,
): Promise<void> {
  const controles = await lireControles(deps, racine)
  if (controle == null) delete controles[file]
  else controles[file] = controle

  try {
    await deps.fs.writeFile(
      join(racine, FICHIER_CONTROLES),
      JSON.stringify({ version: 1, entries: controles }, null, 2),
    )
  } catch (cause) {
    // Le verdict revient quand même à l'écran : perdre la trace au rechargement
    // vaut mieux que faire croire que le contrôle n'a pas eu lieu.
    deps.onLog?.('warn', 'verdicts de contrôle non écrits sur le disque', {
      message: (cause as Error).message,
    })
  }
}

async function lireControles(
  deps: VodIndexDeps,
  racine: string,
): Promise<Record<string, ControleVod>> {
  const brut = await deps.fs.readFile(join(racine, FICHIER_CONTROLES)).catch(() => null)
  if (brut == null) return {}
  try {
    const corps = JSON.parse(brut) as { entries?: Record<string, ControleVod> }
    return corps.entries ?? {}
  } catch {
    return {}
  }
}

async function lireSidecar(deps: VodIndexDeps, cheminVideo: string): Promise<Sidecar | null> {
  const chemin = cheminVideo.slice(0, cheminVideo.length - extname(cheminVideo).length) + '.json'
  const brut = await deps.fs.readFile(chemin).catch(() => null)
  if (brut == null) return null
  try {
    return JSON.parse(brut) as Sidecar
  } catch {
    return null
  }
}

/**
 * Résout un nom venu de la page sous la racine, et refuse tout le reste.
 *
 * La page de régie est servie en HTTP sur la machine : un `..` dans le nom du
 * fichier ferait sortir du dossier des captations.
 */
export function cheminSur(racine: string, file: string): string {
  const chemin = resolve(racine, file)
  if (chemin === racine || !chemin.startsWith(racine.endsWith(sep) ? racine : racine + sep)) {
    throw new Error('Fichier hors du dossier des enregistrements')
  }
  return chemin
}

const normaliser = (chemin: string): string => chemin.split(sep).join('/')

const minutes = (ms: number): string => {
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s`
}

/**
 * Un extrait lisible dans le navigateur, produit à la volée.
 *
 * `arreter` compte autant que le flux : une régie qui referme la modale ne doit
 * pas laisser un ffmpeg tourner sur la machine qui enregistre.
 */
export interface Extrait {
  flux: Readable
  arreter(): void
}

/** Un rush servi tel quel, éventuellement par tranche. */
export interface FluxFichier {
  flux: Readable
  /** Taille totale du fichier, qu'on serve tout ou une tranche. */
  taille: number
  debut: number
  fin: number
  type: string
}

const TYPES: Record<string, string> = {
  '.mkv': 'video/x-matroska',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t',
  '.mpegts': 'video/mp2t',
}

/**
 * Codecs qu'on peut remballer en MP4 sans réencoder.
 *
 * Le cas normal des rushes d'OBS, et il change tout : remballer coûte
 * quelques millisecondes, réencoder mobilise le processeur de la machine qui
 * est justement en train d'enregistrer la conférence suivante.
 */
const COPIABLES = { video: new Set(['h264', 'hevc']), audio: new Set(['aac', 'mp3']) }

/** Ce qu'un outil externe a répondu, retenu pour la session. */
const outils = new Map<string, Promise<boolean>>()

/**
 * Présence d'un outil externe, demandée une fois.
 *
 * Ni ffmpeg ni ffprobe ne sont des dépendances du poste : ils arrivent avec la
 * plupart des installations d'OBS, et pas avec toutes. La page doit pouvoir le
 * dire d'avance plutôt que d'afficher un lecteur qui ne démarrera jamais.
 */
export async function outilDisponible(commande: string): Promise<boolean> {
  const connu = outils.get(commande)
  if (connu != null) return await connu

  const sonde = (async () => {
    const { execFile } = await import('node:child_process')
    return await new Promise<boolean>((termine) => {
      execFile(commande, ['-version'], { timeout: 5_000, windowsHide: true }, (erreur) =>
        termine(erreur == null),
      )
    })
  })()
  outils.set(commande, sonde)
  return await sonde
}

/**
 * Extrait de quelques secondes, en MP4 fragmenté.
 *
 * Fragmenté, donc lisible pendant qu'il s'écrit : le navigateur n'attend pas la
 * fin du fichier pour afficher une image. C'est ce qui permet de servir un
 * Matroska — qu'aucun navigateur ne sait ouvrir — à un `<video>` ordinaire,
 * sans rien écrire sur le disque.
 *
 * `null` veut dire « ffmpeg absent » : la page le dit, elle ne feint pas.
 */
export async function ouvrirExtrait(
  deps: VodIndexDeps,
  file: string,
  options: { atMs?: number; dureeMs?: number; commande?: string } = {},
): Promise<Extrait | null> {
  const commande = options.commande ?? 'ffmpeg'
  if (!(await outilDisponible(commande))) return null

  const chemin = cheminSur(resolve(deps.root), file)
  if ((await deps.fs.stat(chemin)) == null) throw new Error('Fichier absent du disque')

  const depart = Math.max(0, Math.round((options.atMs ?? 0) / 1000))
  const duree = Math.min(120, Math.max(5, Math.round((options.dureeMs ?? 20_000) / 1000)))

  const sondage = deps.probe == null ? null : await deps.probe(chemin)
  const copiable =
    sondage != null &&
    sondage.video != null &&
    sondage.audio != null &&
    COPIABLES.video.has(sondage.video.codec) &&
    COPIABLES.audio.has(sondage.audio.codec)

  const sortie = copiable
    ? ['-c', 'copy']
    : // Le repli : petit, rapide, et suffisant pour répondre à « est-ce qu'il y
      // a une image et du son ». Personne ne monte depuis cet aperçu.
      ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-vf', 'scale=-2:480', '-c:a', 'aac', '-b:a', '96k']

  const { spawn } = await import('node:child_process')
  const processus = spawn(
    commande,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      // `-ss` avant `-i` : ffmpeg saute directement à l'image-clé la plus proche
      // au lieu de décoder deux heures pour en garder vingt secondes.
      '-ss',
      String(depart),
      '-i',
      chemin,
      '-t',
      String(duree),
      ...sortie,
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      '-f',
      'mp4',
      'pipe:1',
    ],
    { windowsHide: true },
  )

  let erreurs = ''
  processus.stderr.on('data', (morceau: Buffer) => {
    erreurs = (erreurs + morceau.toString()).slice(-2_000)
  })
  processus.on('close', (code) => {
    if (code !== 0 && code != null) {
      deps.onLog?.('warn', 'aperçu VOD interrompu', { file, code, message: erreurs.trim() })
    }
  })
  processus.on('error', (cause) => {
    deps.onLog?.('warn', 'aperçu VOD impossible', { file, message: (cause as Error).message })
    processus.stdout.destroy()
  })

  return {
    flux: processus.stdout,
    arreter: () => {
      processus.kill('SIGKILL')
    },
  }
}

/**
 * Le rush lui-même, éventuellement par tranche.
 *
 * Sert à l'ouvrir dans un lecteur qui, lui, sait lire du Matroska — ou à le
 * récupérer sur une autre machine, ce que la modale ne remplacera jamais. Les
 * tranches (`Range`) sont ce qui rend un fichier de trois gigaoctets navigable
 * au lieu de se télécharger en entier avant la première image.
 */
export async function ouvrirFichier(
  deps: VodIndexDeps,
  file: string,
  plage?: string | null,
): Promise<FluxFichier | null> {
  const chemin = cheminSur(resolve(deps.root), file)
  const stat = await deps.fs.stat(chemin)
  if (stat == null) return null

  let debut = 0
  let fin = Math.max(0, stat.size - 1)
  const demande = /^bytes=(\d*)-(\d*)$/.exec((plage ?? '').trim())
  if (demande != null && stat.size > 0) {
    const [, premier, dernier] = demande
    if (premier !== '') {
      debut = Math.min(Number(premier), fin)
      if (dernier !== '') fin = Math.min(Number(dernier), fin)
    } else if (dernier !== '') {
      // `bytes=-500` : les cinq cents derniers octets, ce que réclament les
      // lecteurs pour aller chercher l'index en fin de conteneur.
      debut = Math.max(0, stat.size - Number(dernier))
    }
  }

  return {
    flux: createReadStream(chemin, { start: debut, end: fin }),
    taille: stat.size,
    debut,
    fin,
    type: TYPES[extname(chemin).toLowerCase()] ?? 'application/octet-stream',
  }
}

/** Accès disque réel. Injecté, donc remplaçable en test. */
export function nodeVodFs(): VodFs {
  return {
    async readdir(path: string) {
      const { readdir } = await import('node:fs/promises')
      const entries = await readdir(path, { withFileTypes: true })
      return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
    },
    async stat(path: string) {
      const { stat } = await import('node:fs/promises')
      return stat(path).then(
        (info) => ({ size: info.size, mtimeMs: info.mtimeMs }),
        () => null,
      )
    },
    async readFile(path: string) {
      const { readFile } = await import('node:fs/promises')
      return readFile(path, 'utf8').then(
        (contents) => contents,
        () => null,
      )
    },
    async writeFile(path: string, contents: string) {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(path, contents, 'utf8')
    },
  }
}

/**
 * Sonde le conteneur avec ffprobe.
 *
 * ffprobe n'est pas une dépendance du poste : il arrive avec OBS sur la plupart
 * des installations, et pas du tout sur d'autres. Son absence n'est donc pas
 * une erreur — elle réduit le contrôle, et la régie le dit plutôt que de
 * prétendre avoir regardé.
 */
export function ffprobeSonde(commande = 'ffprobe') {
  return async (chemin: string): Promise<SondageVod | null> => {
    const { execFile } = await import('node:child_process')
    const resultat = await new Promise<{ erreur: EchecProcessus | null; stdout: string }>((resolve) => {
      execFile(
        commande,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', chemin],
        { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (erreur, stdout) => resolve({ erreur: erreur as EchecProcessus | null, stdout }),
      )
    })

    /**
     * Départager « l'outil n'a pas répondu » de « le fichier est mauvais ».
     *
     * Un seul cas accuse le fichier : ffprobe est allé au bout et a rendu un
     * code de sortie non nul — `code` est alors un **nombre**. Binaire absent
     * ou non exécutable, délai dépassé, sortie trop volumineuse : `code` est
     * une chaîne ou le processus a été tué, et l'on ne sait rien du fichier.
     * Confondre les deux ferait accuser un rush intact parce que le poste
     * n'avait pas ffprobe — exactement l'erreur de diagnostic que ce contrôle
     * est censé éviter.
     */
    const erreur = resultat.erreur
    if (erreur != null) {
      const refuseParFfprobe = typeof erreur.code === 'number' && erreur.killed !== true
      return refuseParFfprobe ? CONTENEUR_REFUSE : null
    }

    try {
      return lireSortieFfprobe(resultat.stdout)
    } catch {
      return CONTENEUR_REFUSE
    }
  }
}

/** Ce que `execFile` rend en cas d'échec : code de sortie **ou** code système. */
interface EchecProcessus extends Error {
  code?: number | string
  killed?: boolean
}

/** ffprobe a bien tourné, et n'a rien reconnu dans le fichier. */
const CONTENEUR_REFUSE: SondageVod = {
  ouvert: false,
  durationMs: null,
  video: null,
  audio: null,
  bitrateKbps: null,
}

/** Extrait de la sortie ffprobe les seules choses qui décident du verdict. */
export function lireSortieFfprobe(brut: string): SondageVod {
  const corps = JSON.parse(brut) as {
    streams?: {
      codec_type?: string
      codec_name?: string
      width?: number
      height?: number
      channels?: number
      avg_frame_rate?: string
      duration?: string
    }[]
    format?: { duration?: string; bit_rate?: string }
  }

  const flux = corps.streams ?? []
  const video = flux.find((piste) => piste.codec_type === 'video')
  const audio = flux.find((piste) => piste.codec_type === 'audio')

  // La durée du conteneur manque sur les Matroska écrits en flux : celle de la
  // piste vidéo répond alors, et c'est précisément le cas des rushes d'OBS.
  const duree = nombre(corps.format?.duration) ?? nombre(video?.duration) ?? null

  return {
    ouvert: true,
    durationMs: duree == null ? null : Math.round(duree * 1000),
    video:
      video == null
        ? null
        : {
            codec: video.codec_name ?? 'inconnu',
            width: video.width ?? 0,
            height: video.height ?? 0,
            fps: fraction(video.avg_frame_rate),
          },
    audio: audio == null ? null : { codec: audio.codec_name ?? 'inconnu', channels: audio.channels ?? 0 },
    bitrateKbps: (() => {
      const bits = nombre(corps.format?.bit_rate)
      return bits == null ? null : Math.round(bits / 1000)
    })(),
  }
}

const nombre = (valeur: string | undefined): number | null => {
  if (valeur == null) return null
  const parse = Number(valeur)
  return Number.isFinite(parse) && parse > 0 ? parse : null
}

const fraction = (valeur: string | undefined): number | null => {
  if (valeur == null) return null
  const [haut, bas] = valeur.split('/')
  const numerateur = Number(haut)
  const denominateur = bas == null ? 1 : Number(bas)
  if (!Number.isFinite(numerateur) || !Number.isFinite(denominateur) || denominateur === 0) return null
  const fps = numerateur / denominateur
  return fps > 0 ? Math.round(fps * 100) / 100 : null
}
