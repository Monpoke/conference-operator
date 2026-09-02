import { basename, dirname, extname, join } from 'node:path'
import type { Session } from '@cloudnord/program'

import type { Marker, MarkerRole, ReperesMontage, Sidecar } from '@cloudnord/contract'

export type { Marker, MarkerRole, ReperesMontage, Sidecar }

export interface RecordingFs {
  rename(from: string, to: string): Promise<void>
  writeFile(path: string, contents: string): Promise<void>
  exists(path: string): Promise<boolean>
}

export interface RecordingDeps {
  /** Applique le format de nom de fichier avant `StartRecord`. */
  setFilenameFormat: (format: string) => Promise<void>
  startRecord: () => Promise<void>
  stopRecord: () => Promise<void>
  fs: RecordingFs
  /**
   * Où OBS écrit ses masters.
   *
   * Sert **uniquement de repli**, quand OBS n'a pas annoncé le fichier produit.
   * Le chemin qu'il annonce reste la source : lui seul dit ce qui a réellement
   * été écrit, y compris quand le format de nom n'a pas pris.
   */
  recordingRoot?: () => Promise<string | null>
  now: () => number
  /** Horloge corrigée de l'offset serveur : les timecodes en dépendent. */
  correctedNow: () => number
  /**
   * Mesurer la durée sur l'horloge corrigée plutôt que sur le temps réel.
   * **Développement seulement.**
   *
   * En production c'est le temps monotone qui fait foi, et c'est le bon choix :
   * une durée de captation ne doit pas bouger parce que le poste a resynchronisé
   * son horloge en pleine conférence. Un talk de cinquante minutes dure
   * cinquante minutes, quoi qu'en dise `Date.now()`.
   *
   * En développement, la même règle rend la simulation illisible. On y déroule
   * une journée en poussant l'horloge du hub — 09:00, on lance la captation,
   * on saute à 09:50 pour simuler la fin — et la prise annonçait « 3 min »,
   * le temps réellement passé devant l'écran, pendant que la timeline affichait
   * un créneau de cinquante minutes. Les deux chiffres décrivaient le même
   * enregistrement et ne se ressemblaient pas.
   *
   * Le début et la fin suivaient déjà l'horloge corrigée : seule la durée
   * restait sur le temps réel, et c'est ce désaccord qu'on lève ici.
   */
  suitLHorloge?: boolean
  onLog?: (level: 'info' | 'warn' | 'error', message: string, context?: unknown) => void
}

/**
 * Conteneurs qu'OBS sait écrire, dans l'ordre où on les cherche.
 *
 * Sert au repli : sans le chemin annoncé, on connaît le nom attendu mais pas
 * l'extension, qui dépend du réglage de sortie d'OBS.
 */
const EXTENSIONS_MASTER = ['.mkv', '.mp4', '.mov', '.flv', '.ts', '.m4v', '.webm']

export interface StartInput {
  session: Session | null
  roomId: string | null
  /** Libellé court de la salle utilisé dans le nom de fichier (`track1`). */
  roomSlug: string
  timezone: string
}

export interface StopResult {
  sidecarPath: string | null
  videoPath: string | null
  sidecar: Sidecar
}

export interface StopOptions {
  /**
   * OBS s'est déjà arrêté tout seul : ne pas lui redemander.
   *
   * Le cas de l'opérateur qui appuie sur « Arrêter l'enregistrement » dans OBS
   * plutôt que dans la régie. `StopRecord` sur une sortie déjà inactive est une
   * erreur d'OBS, et cette erreur emporterait tout le reste de l'arrêt — le
   * sidecar en premier, c'est-à-dire précisément ce qu'on est venu sauver.
   *
   * Faux par défaut, et il faut que ça le reste : avaler l'échec de `StopRecord`
   * sur le chemin normal ferait écrire le sidecar d'une prise encore en cours.
   */
  dejaArrete?: boolean
}

/**
 * Pilote un enregistrement de talk et produit son sidecar.
 *
 * Le sidecar est ce qui rend le montage et l'upload quasi automatiques après
 * l'événement — et il est écrit **en local**, donc produit même si le hub est
 * injoignable toute la journée.
 */
export class RecordingSession {
  private startedAtMs: number | null = null
  /** Même départ, lu sur l'horloge corrigée : la base du temps de captation en dev. */
  private startedAtCorrigeMs: number | null = null
  private startedAtIso: string | null = null
  private markers: Marker[] = []
  private input: StartInput | null = null

  constructor(private readonly deps: RecordingDeps) {}

  get active(): boolean {
    return this.startedAtMs != null
  }

  /**
   * Les marqueurs de chapitre, les deux repères de montage exclus.
   *
   * Ce compte s'affiche en régie juste à côté de l'état des repères : y
   * inclure le début et la fin faisait passer « aucun marqueur » à
   * « 2 marqueur(s) » sans qu'aucun chapitre ait été posé, à côté d'une ligne
   * qui disait déjà que les deux repères étaient là.
   */
  get markerCount(): number {
    return this.markers.filter((marker) => marker.role == null).length
  }

  /** Instant de départ, pour le chronomètre affiché en régie. */
  get startedAt(): number | null {
    return this.startedAtMs
  }

  /**
   * Le même départ sur l'horloge corrigée — ou `null` si elle ne fait pas foi.
   *
   * Un seul champ qui porte à la fois la valeur et la règle : `null` dit à la
   * régie « compte en temps réel », un nombre dit « compte sur l'horloge du
   * hub, celle qui peut sauter ». Sans quoi le chronomètre affiché pendant la
   * prise continuerait de compter les minutes passées devant l'écran pendant
   * que la durée enregistrée, elle, suivrait la journée simulée — deux
   * chiffres pour le même enregistrement, encore.
   */
  get startedAtCorrige(): number | null {
    return this.deps.suitLHorloge === true ? this.startedAtCorrigeMs : null
  }

  /**
   * Démarre l'enregistrement.
   *
   * Le format de nom est posé *avant* `StartRecord` : OBS le lit à ce
   * moment-là. Si ça échoue, on n'annule pas pour autant — un enregistrement
   * mal nommé vaut infiniment mieux qu'un talk non enregistré.
   */
  async start(input: StartInput): Promise<void> {
    if (this.active) throw new Error('Un enregistrement est déjà en cours')

    const format = buildFilenameFormat(input)
    try {
      await this.deps.setFilenameFormat(format)
    } catch (cause) {
      this.deps.onLog?.('warn', 'format de nom refusé par OBS, renommage au stop', {
        format,
        message: (cause as Error).message,
      })
    }

    await this.deps.startRecord()
    this.startedAtMs = this.deps.now()
    const departCorrige = this.deps.correctedNow()
    this.startedAtCorrigeMs = departCorrige
    this.startedAtIso = new Date(departCorrige).toISOString()
    this.markers = []
    this.input = input
  }

  /**
   * Temps écoulé depuis le début de la prise.
   *
   * Deux horloges, une par mode. Le temps monotone en production : une durée de
   * captation ne doit pas bouger parce que le poste a resynchronisé son horloge
   * en pleine conférence. L'horloge corrigée en développement : c'est en la
   * poussant qu'on y déroule une journée, et la prise doit suivre ce qu'elle
   * raconte plutôt que le temps passé devant l'écran.
   *
   * Jamais négatif. Reculer l'horloge de développement ramène donc la prise à
   * zéro — c'est la conséquence assumée de la suivre, et ça vaut mieux qu'une
   * durée négative qui casserait tout ce qui la lit en aval.
   */
  private ecouleMs(): number {
    if (this.startedAtMs == null) return 0
    if (this.deps.suitLHorloge === true && this.startedAtCorrigeMs != null) {
      return Math.max(0, this.deps.correctedNow() - this.startedAtCorrigeMs)
    }
    return Math.max(0, this.deps.now() - this.startedAtMs)
  }

  /**
   * Pose un marqueur à l'instant courant.
   *
   * `role` distingue les deux repères de montage du chapitre ordinaire, et ils
   * ne se comportent pas pareil : **reposer un repère remplace le précédent**.
   * C'est le geste qu'on fait réellement — on repose le début parce que
   * l'orateur a eu un faux départ, on repose la fin parce que les questions ont
   * repris après ce qu'on croyait être le mot de la fin. En empiler deux
   * laisserait au montage, trois semaines plus tard, un arbitrage que seule la
   * régie pouvait trancher, sur l'instant.
   */
  mark(label: string, role: MarkerRole | null = null): Marker {
    if (this.startedAtMs == null) throw new Error('Aucun enregistrement en cours')
    const marker: Marker = {
      label,
      // Même horloge que la durée : un marqueur posé après un saut d'horloge
      // doit tomber au même endroit que ce que la prise annonce durer.
      offsetMs: this.ecouleMs(),
      at: new Date(this.deps.correctedNow()).toISOString(),
      // Le champ n'apparaît pas sur un chapitre : un sidecar où chaque marqueur
      // porte `"role": null` ferait croire à un rôle qu'on aurait effacé.
      ...(role == null ? {} : { role }),
    }
    if (role != null) this.markers = this.markers.filter((pose) => pose.role !== role)
    this.markers.push(marker)
    /*
     * Rangés par décalage, et non par ordre de pose.
     *
     * Les deux coïncident tant qu'on empile, et divergent dès qu'un repère est
     * reposé : un début redéplacé à 2 min se retrouvait derrière le chapitre
     * de 1 min. Le sidecar est lu par un montage qui en tire des chapitres —
     * lui livrer une liste en désordre revient à lui demander de réparer là-bas
     * ce qui se range ici en une ligne.
     */
    this.markers.sort((a, b) => a.offsetMs - b.offsetMs)
    return marker
  }

  /**
   * Où tombent les deux repères, pour que la régie les montre.
   *
   * Le compte de marqueurs ne répondait pas à la question qu'on se pose avant
   * d'arrêter une prise — « est-ce que j'ai posé le début ? » —, puisque trois
   * marqueurs peuvent être trois chapitres.
   */
  get montage(): ReperesMontage {
    const de = (role: MarkerRole): number | null =>
      this.markers.find((marker) => marker.role === role)?.offsetMs ?? null
    return { debutMs: de('debut'), finMs: de('fin') }
  }

  /**
   * Arrête l'enregistrement et écrit le sidecar.
   *
   * `resolveOutputPath` est appelé **après** `StopRecord`, et c'est essentiel :
   * OBS n'annonce le chemin du fichier que dans l'événement
   * `RecordStateChanged` qui suit l'arrêt. Le lire avant donnerait toujours
   * `null`, et aucun sidecar ne serait jamais écrit.
   *
   * Ce chemin dit ce qu'OBS a réellement écrit, le format de nom ayant pu ne
   * pas s'appliquer — mais il le dit **dans l'espace de nommage de la machine
   * qui fait tourner OBS**, qui n'est pas toujours la nôtre. Voir
   * `resoudreMaster`.
   */
  async stop(
    resolveOutputPath: () => Promise<string | null>,
    options: StopOptions = {},
  ): Promise<StopResult> {
    if (this.startedAtMs == null || this.input == null) {
      throw new Error('Aucun enregistrement en cours')
    }

    if (options.dejaArrete !== true) await this.deps.stopRecord()
    const outputPath = await resolveOutputPath()
    const endedAtIso = new Date(this.deps.correctedNow()).toISOString()
    const durationMs = this.ecouleMs()
    const input = this.input
    const session = input.session

    let videoPath = await this.resoudreMaster(outputPath, input)
    if (videoPath != null && videoPath !== outputPath) {
      this.deps.onLog?.('info', 'master retrouvé sous la racine des captations', {
        annonce: outputPath,
        retenu: videoPath,
      })
    }

    if (videoPath != null) {
      const attendu = buildFilenameFormat(input) + extname(videoPath)
      const cible = join(dirname(videoPath), attendu)
      if (basename(videoPath) !== attendu && !(await this.deps.fs.exists(cible))) {
        try {
          await this.deps.fs.rename(videoPath, cible)
          videoPath = cible
        } catch (cause) {
          this.deps.onLog?.('warn', 'renommage impossible, chemin OBS conservé', {
            from: videoPath,
            message: (cause as Error).message,
          })
        }
      }
    }

    const sidecar: Sidecar = {
      sessionId: session?.id ?? null,
      title: session?.title ?? 'Sans titre',
      speakers: (session?.speakers ?? []).map((speaker) => ({
        name: speaker.name,
        company: speaker.company,
      })),
      roomId: input.roomId,
      trackTitle: session?.roomId ?? null,
      category: session?.category?.name ?? null,
      startedAt: this.startedAtIso!,
      endedAt: endedAtIso,
      durationMs,
      markers: this.markers,
      videoFile: videoPath == null ? null : basename(videoPath),
    }

    let sidecarPath: string | null = null
    if (videoPath != null) {
      sidecarPath = videoPath.replace(new RegExp(`${escapeRegExp(extname(videoPath))}$`), '.json')
      try {
        await this.deps.fs.writeFile(sidecarPath, JSON.stringify(sidecar, null, 2))
      } catch (cause) {
        this.deps.onLog?.('error', "sidecar non écrit : le montage devra être fait à la main", {
          path: sidecarPath,
          message: (cause as Error).message,
        })
        sidecarPath = null
      }
    } else {
      this.deps.onLog?.('warn', "OBS n'a pas rendu de chemin de sortie, aucun sidecar écrit")
    }

    this.startedAtMs = null
    this.startedAtCorrigeMs = null
    this.startedAtIso = null
    this.input = null
    return { sidecarPath, videoPath, sidecar }
  }

  /**
   * Le master, tel que **nous** pouvons l'ouvrir.
   *
   * OBS annonce un chemin dans l'espace de nommage de la machine qui le fait
   * tourner, et ce n'est pas toujours la nôtre. Le cas s'est vu en clair : OBS
   * sous Windows enregistrant dans un dossier WSL, et annonçant
   * `//wsl.localhost/distro/home/…/prise.mp4`. Le fichier était bien là, à un
   * chemin Linux parfaitement ordinaire ; nous écrivions le sidecar à côté d'un
   * chemin qui n'existe pas de ce côté-ci, l'écriture échouait, et chaque prise
   * de la journée perdait titre, intervenants et marqueurs. La même chose
   * arrive avec un dossier réseau monté différemment sur les deux machines.
   *
   * Trois sources, dans cet ordre, et l'ordre porte le sens :
   *
   * 1. **Le chemin annoncé, s'il désigne un fichier que nous voyons.** C'est le
   *    cas de loin le plus courant — OBS et la salle sur la même machine — et
   *    c'est la réponse exacte : lui seul sait ce qui a été écrit.
   * 2. **Le nom annoncé, sous la racine des captations.** OBS reste la source
   *    du *nom* — y compris le « (2) » qu'il ajoute sur une collision — mais le
   *    *dossier* vient du réglage de la salle, qui est un chemin de notre côté.
   * 3. **Le nom que nous avons dicté à OBS**, si rien n'a été annoncé du tout.
   *
   * Prudent de bout en bout : faute de trouver un conteneur, on renonce plutôt
   * que de semer un sidecar orphelin dans le dossier des captations.
   */
  private async resoudreMaster(annonce: string | null, input: StartInput): Promise<string | null> {
    if (annonce != null && (await this.deps.fs.exists(annonce))) return annonce

    let racine: string | null = null
    try {
      racine = (await this.deps.recordingRoot?.()) ?? null
    } catch {
      racine = null
    }
    if (racine == null) return null

    if (annonce != null) {
      const nom = nomDeFichier(annonce)
      const candidat = join(racine, nom)
      if (nom !== '' && (await this.deps.fs.exists(candidat))) return candidat
    }

    const attendu = buildFilenameFormat(input)
    for (const extension of EXTENSIONS_MASTER) {
      const candidat = join(racine, attendu + extension)
      if (await this.deps.fs.exists(candidat)) return candidat
    }
    return null
  }
}

/**
 * Le dernier segment d'un chemin, quel que soit l'OS qui l'a écrit.
 *
 * `basename` de Node ne connaît que le séparateur de la plateforme courante :
 * sous Linux, il rend `C:\prises\talk.mkv` en entier, faute d'y voir la
 * moindre barre. Or le chemin que nous découpons ici vient de la machine
 * **d'OBS**, pas de la nôtre.
 */
function nomDeFichier(chemin: string): string {
  const morceaux = chemin.split(/[\\/]/)
  return morceaux[morceaux.length - 1] ?? ''
}

/**
 * `2026-10-30_track1_1100_titre-du-talk`
 *
 * Trié naturellement par date et salle, et lisible sans ouvrir le fichier —
 * ce qui compte quand on récupère trois cartes SD en fin de journée.
 */
export function buildFilenameFormat(input: StartInput): string {
  const session = input.session
  const reference = session?.startsAt ?? new Date().toISOString()
  const date = formatInTimezone(reference, input.timezone, { year: 'numeric', month: '2-digit', day: '2-digit' })
  const heure = formatInTimezone(reference, input.timezone, { hour: '2-digit', minute: '2-digit' })

  const titre = slugify(session?.title ?? 'sans-titre')
  return `${date}_${input.roomSlug}_${heure}_${titre}`
}

function formatInTimezone(iso: string, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  const parts = new Intl.DateTimeFormat('fr-FR', { ...options, timeZone }).formatToParts(new Date(iso))
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  if (options.hour != null) return `${get('hour')}${get('minute')}`
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** Sans accents ni caractères douteux : ces fichiers traversent Windows, macOS et YouTube. */
export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '') || 'sans-titre'
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
