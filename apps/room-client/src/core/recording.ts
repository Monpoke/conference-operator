import { basename, dirname, extname, join } from 'node:path'
import type { Session } from '@cloudnord/program'

import type { Marker, Sidecar } from '@cloudnord/contract'

export type { Marker, Sidecar }

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

  get markerCount(): number {
    return this.markers.length
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

  /** Pose un marqueur de chapitre à l'instant courant. */
  mark(label: string): Marker {
    if (this.startedAtMs == null) throw new Error('Aucun enregistrement en cours')
    const marker: Marker = {
      label,
      // Même horloge que la durée : un marqueur posé après un saut d'horloge
      // doit tomber au même endroit que ce que la prise annonce durer.
      offsetMs: this.ecouleMs(),
      at: new Date(this.deps.correctedNow()).toISOString(),
    }
    this.markers.push(marker)
    return marker
  }

  /**
   * Arrête l'enregistrement et écrit le sidecar.
   *
   * `resolveOutputPath` est appelé **après** `StopRecord`, et c'est essentiel :
   * OBS n'annonce le chemin du fichier que dans l'événement
   * `RecordStateChanged` qui suit l'arrêt. Le lire avant donnerait toujours
   * `null`, et aucun sidecar ne serait jamais écrit.
   *
   * Ce chemin est la seule source fiable, le format de nom ayant pu ne pas
   * s'appliquer — auquel cas on renomme nous-mêmes.
   */
  async stop(resolveOutputPath: () => Promise<string | null>): Promise<StopResult> {
    if (this.startedAtMs == null || this.input == null) {
      throw new Error('Aucun enregistrement en cours')
    }

    await this.deps.stopRecord()
    const outputPath = await resolveOutputPath()
    const endedAtIso = new Date(this.deps.correctedNow()).toISOString()
    const durationMs = this.ecouleMs()
    const input = this.input
    const session = input.session

    let videoPath = outputPath
    if (outputPath != null) {
      const attendu = buildFilenameFormat(input) + extname(outputPath)
      const cible = join(dirname(outputPath), attendu)
      if (basename(outputPath) !== attendu && !(await this.deps.fs.exists(cible))) {
        try {
          await this.deps.fs.rename(outputPath, cible)
          videoPath = cible
        } catch (cause) {
          this.deps.onLog?.('warn', 'renommage impossible, chemin OBS conservé', {
            from: outputPath,
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
