import { basename, dirname, extname, join } from 'node:path'
import type { Session } from '@cloudnord/program'

export interface Marker {
  label: string
  /** Décalage depuis le début de l'enregistrement — ce qui sert au montage. */
  offsetMs: number
  at: string
}

/** Métadonnées écrites à côté du master, pour le montage et l'upload. */
export interface Sidecar {
  sessionId: string | null
  title: string
  speakers: { name: string; company: string | null }[]
  roomId: string | null
  trackTitle: string | null
  category: string | null
  startedAt: string
  endedAt: string
  durationMs: number
  markers: Marker[]
  /** Nom final du fichier vidéo, une fois renommé. */
  videoFile: string | null
}

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
    this.startedAtIso = new Date(this.deps.correctedNow()).toISOString()
    this.markers = []
    this.input = input
  }

  /** Pose un marqueur de chapitre à l'instant courant. */
  mark(label: string): Marker {
    if (this.startedAtMs == null) throw new Error('Aucun enregistrement en cours')
    const marker: Marker = {
      label,
      offsetMs: Math.max(0, this.deps.now() - this.startedAtMs),
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
    const durationMs = Math.max(0, this.deps.now() - this.startedAtMs)
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
