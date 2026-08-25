import type { ObsInstance, SceneRole } from '@cloudnord/contract'

/**
 * Surface d'OBS dont on a réellement besoin.
 *
 * L'abstraction existe pour une raison précise : `obs-websocket-js` exige une
 * instance OBS qui tourne, donc sans elle la logique de résolution des rôles et
 * de reconnexion ne serait testable que sur une machine de régie.
 */
/**
 * Abonnements d'événements obs-websocket v5 (masque de bits).
 *
 * `InputVolumeMeters` est délibérément **hors** du jeu par défaut côté OBS :
 * il émet une cinquantaine de fois par seconde. On ne s'y abonne donc que
 * pendant qu'une régie regarde les niveaux, et on s'en désabonne ensuite.
 */
export const ABONNEMENTS_OBS = {
  /** Tout ce qu'OBS envoie par défaut : scènes, sorties, entrées… */
  standard: 0x7ff,
  /** Le vumètre, à la charge assumée. */
  niveaux: 1 << 16,
} as const

export interface ObsTransport {
  /** Transport simulé, et non une vraie instance OBS. Voir `obs-mock`. */
  readonly simule?: boolean
  connect(url: string, password?: string, abonnements?: number): Promise<void>
  /** Renégocie les abonnements sans rouvrir la connexion. */
  reidentify?(abonnements: number): Promise<void>
  disconnect(): Promise<void>
  call(request: 'GetSceneList'): Promise<{ currentProgramSceneName: string; scenes: { sceneName: string }[] }>
  call(request: 'SetCurrentProgramScene', args: { sceneName: string }): Promise<unknown>
  call(request: string, args?: Record<string, unknown>): Promise<unknown>
  on(event: string, handler: (payload: never) => void): void
  off?(event: string, handler: (payload: never) => void): void
}

export interface ObsControllerOptions {
  instance: ObsInstance
  url: string
  password?: string | null
  /** Rôle → nom de scène OBS réel, tel que configuré pour cette salle. */
  sceneRoles: Partial<Record<SceneRole, string>>
  transport: ObsTransport
  onStateChange?: (state: ObsState) => void
  onEvent?: (event: ObsControllerEvent) => void
}

export interface ObsState {
  instance: ObsInstance
  connected: boolean
  /** Scène courante telle qu'annoncée par OBS, jamais supposée par nous. */
  currentSceneName: string | null
  currentRole: SceneRole | null
  /** Rôles configurés mais absents d'OBS : à afficher en rouge dans la régie. */
  unresolvedRoles: SceneRole[]
  /**
   * L'instance est simulée.
   *
   * À signaler partout où l'on croit piloter OBS : un enregistrement simulé
   * ressemble en tout point à un vrai, sauf qu'il ne capte rien.
   */
  simulated: boolean
  /**
   * Scènes réellement déclarées dans cette instance.
   *
   * Sert au formulaire de configuration de la régie : choisir un nom de scène
   * dans une liste lue sur OBS vaut mieux que le retaper, puisque c'est
   * justement la faute de frappe qui produit un rôle introuvable.
   */
  scenes: string[]
  recording: boolean
  streaming: boolean
}

export type ObsControllerEvent =
  | {
      type: 'connected'
      unresolvedRoles: SceneRole[]
      /**
       * État constaté à la connexion.
       *
       * Sans lui, l'application ignore ce que fait déjà OBS jusqu'au premier
       * changement : une régie relancée en plein talk afficherait « pas
       * d'enregistrement » alors qu'OBS tourne, et la console verrait une
       * scène vide.
       */
      currentRole: SceneRole | null
      currentSceneName: string | null
      recording: boolean
      streaming: boolean
    }
  | { type: 'disconnected' }
  | { type: 'scene'; sceneName: string; role: SceneRole | null }
  | { type: 'recording'; active: boolean; outputPath: string | null }
  | { type: 'streaming'; active: boolean }
  | { type: 'audio'; inputs: NiveauEntree[] }

/**
 * Niveau d'une entrée audio, en dBFS.
 *
 * OBS envoie des multiplicateurs linéaires ; on convertit ici parce que c'est
 * l'échelle sur laquelle un ingénieur du son raisonne, et celle qu'affiche OBS
 * lui-même. `-60` sert de plancher : en dessous, c'est du silence, et un
 * `-Infinity` casserait tout calcul de largeur de barre côté page.
 */
export interface NiveauEntree {
  nom: string
  /** Un élément par canal : mono en a un, stéréo deux. */
  canaux: { magnitude: number; crete: number }[]
}

/** Plancher d'affichage, en dBFS. */
export const PLANCHER_DB = -60

/** Multiplicateur linéaire d'OBS vers des dBFS bornés. */
export function multiplicateurEnDb(mul: number): number {
  if (!Number.isFinite(mul) || mul <= 0) return PLANCHER_DB
  return Math.max(PLANCHER_DB, 20 * Math.log10(mul))
}

/**
 * Pilote une instance OBS en raisonnant par **rôles**, jamais par noms de scènes.
 *
 * Chaque salle nomme ses scènes comme elle veut ; le code n'en sait rien. Les
 * rôles introuvables sont signalés dès la connexion, pour que le problème se
 * voie à la répétition et pas au milieu d'un talk.
 */
export class ObsController {
  private state: ObsState
  /** Le vumètre survit à une reconnexion : l'abonnement est réappliqué. */
  private niveauxActifs = false

  constructor(private readonly options: ObsControllerOptions) {
    this.state = {
      instance: options.instance,
      connected: false,
      currentSceneName: null,
      currentRole: null,
      unresolvedRoles: [],
      scenes: [],
      simulated: options.transport.simule === true,
      recording: false,
      streaming: false,
    }
    this.bindEvents()
  }

  snapshot(): ObsState {
    return { ...this.state, unresolvedRoles: [...this.state.unresolvedRoles] }
  }

  private patch(patch: Partial<ObsState>): void {
    this.state = { ...this.state, ...patch }
    this.options.onStateChange?.(this.snapshot())
  }

  private bindEvents(): void {
    const { transport } = this.options

    transport.on('CurrentProgramSceneChanged', (payload: never) => {
      const { sceneName } = payload as unknown as { sceneName: string }
      const role = this.roleOf(sceneName)
      this.patch({ currentSceneName: sceneName, currentRole: role })
      this.options.onEvent?.({ type: 'scene', sceneName, role })
    })

    transport.on('InputVolumeMeters', (payload: never) => {
      const { inputs } = payload as unknown as {
        inputs: { inputName: string; inputLevelsMul: number[][] }[]
      }
      this.options.onEvent?.({
        type: 'audio',
        inputs: inputs.map((entree) => ({
          nom: entree.inputName,
          // OBS donne [magnitude, crête, crête d'entrée] par canal ; les deux
          // premières suffisent à afficher une barre et son pic.
          canaux: (entree.inputLevelsMul ?? []).map((canal) => ({
            magnitude: multiplicateurEnDb(canal[0] ?? 0),
            crete: multiplicateurEnDb(canal[1] ?? canal[0] ?? 0),
          })),
        })),
      })
    })

    transport.on('RecordStateChanged', (payload: never) => {
      const event = payload as unknown as { outputActive: boolean; outputPath?: string }
      this.patch({ recording: event.outputActive })
      this.options.onEvent?.({
        type: 'recording',
        active: event.outputActive,
        outputPath: event.outputPath ?? null,
      })
    })

    transport.on('StreamStateChanged', (payload: never) => {
      const event = payload as unknown as { outputActive: boolean }
      this.patch({ streaming: event.outputActive })
      this.options.onEvent?.({ type: 'streaming', active: event.outputActive })
    })

    transport.on('ConnectionClosed', () => {
      this.patch({ connected: false, currentSceneName: null, currentRole: null })
      this.options.onEvent?.({ type: 'disconnected' })
    })
  }

  /**
   * Se connecte et resynchronise l'état depuis OBS.
   *
   * L'état affiché en régie vient toujours d'OBS : si l'opérateur bascule une
   * scène directement dans OBS, la régie doit rester juste.
   */
  /**
   * Active ou coupe le vumètre.
   *
   * Renégocier les abonnements plutôt que filtrer à la réception : sans cela,
   * OBS enverrait 50 messages par seconde en permanence, y compris quand
   * personne ne regarde — pour rien, et sur la machine qui encode.
   */
  async setVolumeMeters(actif: boolean): Promise<void> {
    if (actif === this.niveauxActifs) return
    const { transport } = this.options
    if (transport.reidentify == null) return
    this.niveauxActifs = actif
    await transport.reidentify(
      actif ? ABONNEMENTS_OBS.standard | ABONNEMENTS_OBS.niveaux : ABONNEMENTS_OBS.standard,
    )
  }

  async connect(): Promise<ObsState> {
    await this.options.transport.connect(
      this.options.url,
      this.options.password ?? undefined,
      this.niveauxActifs
        ? ABONNEMENTS_OBS.standard | ABONNEMENTS_OBS.niveaux
        : ABONNEMENTS_OBS.standard,
    )
    const inventaire = await this.lireScenes()

    /**
     * On interroge aussi l'enregistrement et la diffusion.
     *
     * OBS peut très bien être déjà en train d'enregistrer : c'est même le cas
     * qui compte, celui où l'application a redémarré au milieu d'un talk.
     * Tolérant à l'échec — une instance qui ne répond pas à ces requêtes ne
     * doit pas empêcher la connexion.
     */
    let recording = false
    let streaming = false
    try {
      const etat = (await this.options.transport.call('GetRecordStatus')) as { outputActive?: boolean }
      recording = etat.outputActive === true
    } catch {
      /* instance qui ne gère pas la requête */
    }

    /**
     * Une instance simulée ne rapporte aucune prise en cours : on la coupe.
     *
     * Adopter l'enregistrement d'OBS existe pour une seule raison — l'appli a
     * redémarré au milieu d'un talk et la prise, elle, court toujours. Rien de
     * tel avec une instance simulée : elle naît avec l'application, ne capte
     * rien, et ce qu'elle « enregistre » d'une connexion à l'autre n'est le
     * souvenir d'aucune vidéo. La régie s'allumait donc parfois sur une
     * captation en cours que personne n'avait lancée, et qu'il fallait arrêter
     * pour pouvoir en lancer une.
     *
     * On coupe plutôt que d'ignorer : signaler « rien ne capte » en laissant
     * l'instance croire le contraire ferait échouer le prochain « Enregistrer »
     * sur un « déjà en cours » que l'écran contredit.
     */
    if (this.state.simulated && recording) {
      // L'instance simulée tient son propre journal : l'arrêt s'y lit, et un
      // échec ne doit pas empêcher la connexion — on repart de « rien ne capte »
      // dans les deux cas, puisque c'est la vérité de ce qui est capté.
      await this.options.transport.call('StopRecord').catch(() => {})
      recording = false
    }
    try {
      const etat = (await this.options.transport.call('GetStreamStatus')) as { outputActive?: boolean }
      streaming = etat.outputActive === true
    } catch {
      /* idem */
    }

    const { noms, unresolvedRoles, currentSceneName, currentRole } = inventaire
    this.patch({
      connected: true,
      currentSceneName,
      currentRole,
      unresolvedRoles,
      scenes: noms,
      recording,
      streaming,
    })
    this.options.onEvent?.({
      type: 'connected',
      unresolvedRoles,
      currentRole,
      currentSceneName,
      recording,
      streaming,
    })
    return this.snapshot()
  }

  /**
   * Relit les scènes d'OBS et rejoue la résolution des rôles.
   *
   * Renommer ou ajouter une scène dans OBS n'émet aucun événement auquel nous
   * sommes abonnés : sans relecture explicite, le formulaire de configuration
   * proposerait la liste telle qu'elle était à la connexion, et un rôle réparé
   * dans OBS resterait rouge en régie jusqu'au prochain redémarrage.
   */
  async refreshScenes(): Promise<ObsState> {
    const { noms, unresolvedRoles, currentSceneName, currentRole } = await this.lireScenes()
    this.patch({ scenes: noms, unresolvedRoles, currentSceneName, currentRole })
    return this.snapshot()
  }

  /** Inventaire des scènes et des rôles qu'elles résolvent, à un instant donné. */
  private async lireScenes(): Promise<{
    noms: string[]
    unresolvedRoles: SceneRole[]
    currentSceneName: string
    currentRole: SceneRole | null
  }> {
    const { scenes, currentProgramSceneName } = await this.options.transport.call('GetSceneList')
    const noms = scenes.map((scene) => scene.sceneName)
    const presentes = new Set(noms)
    return {
      noms,
      unresolvedRoles: (Object.keys(this.options.sceneRoles) as SceneRole[]).filter((role) => {
        const sceneName = this.options.sceneRoles[role]
        return sceneName == null || !presentes.has(sceneName)
      }),
      currentSceneName: currentProgramSceneName,
      currentRole: this.roleOf(currentProgramSceneName),
    }
  }

  async disconnect(): Promise<void> {
    await this.options.transport.disconnect()
    this.patch({ connected: false })
  }

  /** Bascule sur le rôle demandé. Échoue explicitement si le rôle n'est pas mappé. */
  async setRole(role: SceneRole): Promise<void> {
    const sceneName = this.options.sceneRoles[role]
    if (sceneName == null) {
      throw new Error(
        `Rôle « ${role} » non configuré pour OBS-${this.options.instance} : compléter le mapping de la salle`,
      )
    }
    if (this.state.unresolvedRoles.includes(role)) {
      throw new Error(
        `La scène « ${sceneName} » (rôle ${role}) n'existe pas dans OBS-${this.options.instance}`,
      )
    }
    await this.options.transport.call('SetCurrentProgramScene', { sceneName })
    // On n'anticipe pas l'état : `CurrentProgramSceneChanged` fait foi.
  }

  async startRecording(): Promise<void> {
    await this.options.transport.call('StartRecord')
  }

  async stopRecording(): Promise<void> {
    await this.options.transport.call('StopRecord')
  }

  /**
   * Dossier où OBS écrit ses enregistrements.
   *
   * Sert de repli quand la salle n'a pas renseigné sa racine de captations :
   * c'est OBS qui décide en dernier ressort, et lui seul le sait de source
   * sûre.
   */
  async recordDirectory(): Promise<string | null> {
    const reponse = (await this.options.transport.call('GetRecordDirectory')) as {
      recordDirectory?: string
    }
    const dossier = reponse?.recordDirectory
    return dossier != null && dossier.length > 0 ? dossier : null
  }

  /**
   * Écrit un paramètre de profil OBS — notamment `Output/FilenameFormatting`,
   * lu par OBS au moment du `StartRecord`.
   */
  async setProfileParameter(category: string, name: string, value: string): Promise<void> {
    await this.options.transport.call('SetProfileParameter', {
      parameterCategory: category,
      parameterName: name,
      parameterValue: value,
    })
  }

  /** Applique la clé RTMP avant `StartStream`. */
  async configureStream(rtmpUrl: string, streamKey: string): Promise<void> {
    await this.options.transport.call('SetStreamServiceSettings', {
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: { server: rtmpUrl, key: streamKey },
    })
  }

  async startStream(): Promise<void> {
    await this.options.transport.call('StartStream')
  }

  async stopStream(): Promise<void> {
    await this.options.transport.call('StopStream')
  }

  /** Santé de la diffusion : bitrate et images perdues, pour la télémétrie. */
  async streamStatus(): Promise<{ bitrateKbps: number; skippedFrames: number; congestion: number }> {
    const status = (await this.options.transport.call('GetStreamStatus')) as {
      outputBytes?: number
      outputSkippedFrames?: number
      outputCongestion?: number
    }
    return {
      bitrateKbps: Math.round(((status.outputBytes ?? 0) * 8) / 1000),
      skippedFrames: status.outputSkippedFrames ?? 0,
      congestion: Math.min(1, Math.max(0, status.outputCongestion ?? 0)),
    }
  }

  private roleOf(sceneName: string): SceneRole | null {
    for (const [role, name] of Object.entries(this.options.sceneRoles)) {
      if (name === sceneName) return role as SceneRole
    }
    return null
  }
}
