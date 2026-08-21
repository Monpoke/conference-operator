import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ObsInstance } from '@cloudnord/contract'
import type { ObsTransport } from './obs.js'

/**
 * OBS simulé, pour développer sans installer OBS.
 *
 * Vit dans `core/` et non dans les tests parce qu'il sert au développement
 * quotidien : il permet de dérouler un talk complet — bascule de scène,
 * enregistrement, marqueurs, sidecar — sur une machine nue.
 *
 * Il **écrit un vrai fichier** à l'arrêt de l'enregistrement : sans ça, la
 * chaîne VOD s'arrêterait au renommage et on ne verrait jamais le sidecar,
 * c'est-à-dire précisément la partie qu'on veut pouvoir observer.
 */
export interface MockObsOptions {
  instance: ObsInstance
  scenes?: string[]
  /** Dossier où déposer les faux enregistrements. */
  recordingDir: string
  onLog?: (message: string) => void
}

/** Scènes par défaut, alignées sur le mapping posé à la création d'une salle. */
export const SCENES_PAR_DEFAUT: Record<ObsInstance, string[]> = {
  A: ['Direct — capture HDMI', 'Habillage — écran de salle'],
  B: ['Talk — caméra + slides', 'Caméra seule', 'Slides seules'],
}

export function createMockObsTransport(options: MockObsOptions): ObsTransport {
  const scenes = options.scenes ?? SCENES_PAR_DEFAUT[options.instance]
  const handlers = new Map<string, ((payload: unknown) => void)[]>()

  let sceneCourante = scenes[1] ?? scenes[0]!
  let enregistre = false
  let diffuse = false
  let format = 'enregistrement'
  /** Émission du vumètre, active seulement tant qu'on y est abonné. */
  let vumetre: ReturnType<typeof setInterval> | null = null

  const emettre = (event: string, payload: unknown): void => {
    // Asynchrone, comme le vrai OBS : l'événement suit la réponse à la requête,
    // il n'est pas rendu avec elle.
    setTimeout(() => {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    }, 5)
  }

  const journal = (message: string): void =>
    options.onLog?.(`[OBS-${options.instance} simulé] ${message}`)

  mkdirSync(options.recordingDir, { recursive: true })

  /**
   * Entrées audio simulées, avec un signal plausible.
   *
   * Sans niveaux, le vumètre de la régie ne serait ni démontrable ni
   * observable hors d'une vraie salle — donc jamais regardé avant le jour J.
   * Le micro respire, l'ambiance reste basse, et le retour est muet : trois
   * cas qu'on veut distinguer d'un coup d'œil sur l'écran.
   */
  const ENTREES_AUDIO: { nom: string; base: number; amplitude: number; canaux: number }[] = [
    { nom: 'Micro cravate', base: -18, amplitude: 10, canaux: 1 },
    { nom: 'Ambiance salle', base: -38, amplitude: 6, canaux: 2 },
    { nom: 'Retour régie', base: -60, amplitude: 0, canaux: 2 },
  ]

  let phase = 0
  const mesurer = (): { inputs: { inputName: string; inputLevelsMul: number[][] }[] } => {
    phase += 1
    return {
      inputs: ENTREES_AUDIO.map((entree, index) => {
        // Oscillation lente et décalée par entrée : deux barres identiques
        // donneraient l'impression d'un affichage figé.
        const onde = Math.sin((phase + index * 7) / 6)
        const db = entree.base + entree.amplitude * onde
        const mul = db <= -60 ? 0 : 10 ** (db / 20)
        return {
          inputName: entree.nom,
          inputLevelsMul: Array.from({ length: entree.canaux }, () => [mul, mul * 1.1, mul * 1.1]),
        }
      }),
    }
  }

  const basculerVumetre = (actif: boolean): void => {
    if (actif && vumetre == null) {
      journal('vumètre activé')
      vumetre = setInterval(() => emettre('InputVolumeMeters', mesurer()), 50)
      vumetre.unref?.()
    } else if (!actif && vumetre != null) {
      journal('vumètre coupé')
      clearInterval(vumetre)
      vumetre = null
    }
  }

  /** Le vumètre est-il demandé par ce masque d'abonnements ? */
  const veutNiveaux = (abonnements?: number): boolean =>
    abonnements != null && (abonnements & (1 << 16)) !== 0

  return {
    async connect(_url, _password, abonnements) {
      journal(`connecté — scènes : ${scenes.join(', ')}`)
      basculerVumetre(veutNiveaux(abonnements))
    },
    async reidentify(abonnements) {
      basculerVumetre(veutNiveaux(abonnements))
    },
    async disconnect() {
      basculerVumetre(false)
      journal('déconnecté')
    },
    call: (async (request: string, args?: Record<string, unknown>) => {
      switch (request) {
        case 'GetSceneList':
          return {
            currentProgramSceneName: sceneCourante,
            scenes: scenes.map((sceneName) => ({ sceneName })),
          }

        case 'SetCurrentProgramScene': {
          const cible = String(args?.sceneName)
          if (!scenes.includes(cible)) throw new Error(`Scène inconnue : ${cible}`)
          sceneCourante = cible
          journal(`scène → ${cible}`)
          emettre('CurrentProgramSceneChanged', { sceneName: cible })
          return {}
        }

        case 'SetProfileParameter':
          if (args?.parameterName === 'FilenameFormatting') {
            format = String(args.parameterValue)
          }
          return {}

        case 'StartRecord':
          if (enregistre) throw new Error('Enregistrement déjà en cours')
          enregistre = true
          journal('enregistrement démarré')
          emettre('RecordStateChanged', { outputActive: true })
          return {}

        case 'StopRecord': {
          if (!enregistre) throw new Error('Aucun enregistrement en cours')
          enregistre = false
          const chemin = join(options.recordingDir, `${format}.mkv`)
          // Fichier réel : la chaîne VOD va le renommer et écrire son sidecar.
          writeFileSync(chemin, `enregistrement simulé — ${new Date().toISOString()}\n`)
          journal(`enregistrement arrêté → ${chemin}`)
          emettre('RecordStateChanged', { outputActive: false, outputPath: chemin })
          return {}
        }

        case 'SetStreamServiceSettings':
          journal('paramètres de diffusion appliqués')
          return {}

        case 'StartStream':
          diffuse = true
          journal('diffusion démarrée')
          emettre('StreamStateChanged', { outputActive: true })
          return {}

        case 'StopStream':
          diffuse = false
          journal('diffusion arrêtée')
          emettre('StreamStateChanged', { outputActive: false })
          return {}

        case 'GetRecordStatus':
          // Interrogé à la connexion : une régie relancée doit retrouver l'état.
          return { outputActive: enregistre }

        case 'GetStreamStatus':
          return {
            outputActive: diffuse,
            outputBytes: diffuse ? 750_000 : 0,
            outputSkippedFrames: 0,
            outputCongestion: 0,
          }

        default:
          return {}
      }
    }) as ObsTransport['call'],

    on(event, handler) {
      const liste = handlers.get(event) ?? []
      liste.push(handler as (payload: unknown) => void)
      handlers.set(event, liste)
    },
  }
}
