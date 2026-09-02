import { describe, expect, it, vi } from 'vitest'
import { ObsController, type ObsTransport } from '../src/core/obs.js'

/** OBS factice : implémente le sous-ensemble utilisé, sans instance réelle. */
function fakeObs(scenes: string[], current = scenes[0] ?? 'Scène') {
  const handlers = new Map<string, ((payload: unknown) => void)[]>()
  const calls: { request: string; args?: Record<string, unknown> }[] = []
  let currentScene = current

  const transport: ObsTransport = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    call: (async (request: string, args?: Record<string, unknown>) => {
      calls.push({ request, args })
      if (request === 'GetSceneList') {
        return {
          currentProgramSceneName: currentScene,
          scenes: scenes.map((sceneName) => ({ sceneName })),
        }
      }
      if (request === 'SetCurrentProgramScene') {
        currentScene = args!.sceneName as string
        // OBS confirme toujours par un événement : c'est lui qui fait foi.
        emit('CurrentProgramSceneChanged', { sceneName: currentScene })
      }
      return {}
    }) as ObsTransport['call'],
    on: (event, handler) => {
      const list = handlers.get(event) ?? []
      list.push(handler as (payload: unknown) => void)
      handlers.set(event, list)
    },
  }

  function emit(event: string, payload: unknown): void {
    for (const handler of handlers.get(event) ?? []) handler(payload)
  }

  return { transport, calls, emit, get currentScene() { return currentScene } }
}

const ROLES = { LIVE: 'Capture HDMI', HOLD: 'Habillage web' }

describe('pilotage OBS par rôles', () => {
  it('résout les rôles à la connexion', async () => {
    const obs = fakeObs(['Capture HDMI', 'Habillage web'], 'Habillage web')
    const controller = new ObsController({
      instance: 'A',
      url: 'ws://127.0.0.1:4455',
      sceneRoles: ROLES,
      transport: obs.transport,
    })

    const state = await controller.connect()
    expect(state.connected).toBe(true)
    expect(state.unresolvedRoles).toEqual([])
    // L'état vient d'OBS, pas d'une supposition.
    expect(state.currentSceneName).toBe('Habillage web')
    expect(state.currentRole).toBe('HOLD')
  })

  it('signale les rôles dont la scène n\'existe pas dans OBS', async () => {
    const obs = fakeObs(['Capture HDMI'])
    const events: unknown[] = []
    const controller = new ObsController({
      instance: 'A',
      url: 'ws://127.0.0.1:4455',
      sceneRoles: ROLES,
      transport: obs.transport,
      onEvent: (event) => events.push(event),
    })

    const state = await controller.connect()
    // La salle a renommé « Habillage web » : le problème doit se voir à la
    // répétition, pas au moment de basculer pendant un talk.
    expect(state.unresolvedRoles).toEqual(['HOLD'])
    expect(events[0]).toMatchObject({ type: 'connected', unresolvedRoles: ['HOLD'] })
  })

  it('bascule de scène par rôle', async () => {
    const obs = fakeObs(['Capture HDMI', 'Habillage web'], 'Habillage web')
    const controller = new ObsController({
      instance: 'A',
      url: 'ws://127.0.0.1:4455',
      sceneRoles: ROLES,
      transport: obs.transport,
    })
    await controller.connect()
    await controller.setRole('LIVE')

    expect(obs.currentScene).toBe('Capture HDMI')
    expect(controller.snapshot().currentRole).toBe('LIVE')
  })

  it('refuse un rôle non mappé avec un message actionnable', async () => {
    const obs = fakeObs(['Capture HDMI'])
    const controller = new ObsController({
      instance: 'A',
      url: 'ws://127.0.0.1:4455',
      sceneRoles: { LIVE: 'Capture HDMI' },
      transport: obs.transport,
    })
    await controller.connect()
    await expect(controller.setRole('RELAY')).rejects.toThrow(/non configuré/)
  })

  it('refuse un rôle dont la scène a disparu d\'OBS', async () => {
    const obs = fakeObs(['Capture HDMI'])
    const controller = new ObsController({
      instance: 'A',
      url: 'ws://127.0.0.1:4455',
      sceneRoles: ROLES,
      transport: obs.transport,
    })
    await controller.connect()
    await expect(controller.setRole('HOLD')).rejects.toThrow(/n'existe pas/)
  })

  it('suit une bascule faite directement dans OBS', async () => {
    const obs = fakeObs(['Capture HDMI', 'Habillage web'], 'Habillage web')
    const controller = new ObsController({
      instance: 'A',
      url: 'ws://127.0.0.1:4455',
      sceneRoles: ROLES,
      transport: obs.transport,
    })
    await controller.connect()

    // L'opérateur clique dans OBS, pas dans notre régie : l'affichage doit suivre.
    obs.emit('CurrentProgramSceneChanged', { sceneName: 'Capture HDMI' })
    expect(controller.snapshot().currentRole).toBe('LIVE')
  })

  it('suit l\'état d\'enregistrement et récupère le chemin de sortie', async () => {
    const obs = fakeObs(['Talk'])
    const events: unknown[] = []
    const controller = new ObsController({
      instance: 'B',
      url: 'ws://127.0.0.1:4456',
      sceneRoles: { TALK: 'Talk' },
      transport: obs.transport,
      onEvent: (event) => events.push(event),
    })
    await controller.connect()

    obs.emit('RecordStateChanged', { outputActive: true })
    expect(controller.snapshot().recording).toBe(true)

    obs.emit('RecordStateChanged', { outputActive: false, outputPath: '/rec/talk.mkv' })
    expect(controller.snapshot().recording).toBe(false)
    // Le chemin est ce qui permet de renommer le master et d'écrire le sidecar.
    expect(events.at(-1)).toEqual({
      type: 'recording',
      active: false,
      outputPath: '/rec/talk.mkv',
    })
  })

  it('attend `STOPPED` pour livrer le chemin, et ignore `STOPPING`', async () => {
    const obs = fakeObs(['Talk'])
    const events: unknown[] = []
    const controller = new ObsController({
      instance: 'B',
      url: 'ws://127.0.0.1:4456',
      sceneRoles: { TALK: 'Talk' },
      transport: obs.transport,
      onEvent: (event) => events.push(event),
    })
    await controller.connect()

    // La séquence d'un vrai OBS, que les simulateurs ne reproduisent pas.
    obs.emit('RecordStateChanged', {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING',
    })
    obs.emit('RecordStateChanged', {
      outputActive: true,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED',
    })
    expect(controller.snapshot().recording).toBe(true)
    expect(events.filter((event) => (event as { type: string }).type === 'recording')).toHaveLength(1)

    // `STOPPING` dit déjà « inactif » mais ne porte aucun chemin : le laisser
    // passer résolvait l'attente avec `null`, et le sidecar n'était pas écrit.
    obs.emit('RecordStateChanged', {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPING',
    })
    expect(controller.snapshot().recording).toBe(true)

    obs.emit('RecordStateChanged', {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
      outputPath: '/rec/talk.mkv',
    })
    expect(controller.snapshot().recording).toBe(false)
    expect(events.at(-1)).toEqual({
      type: 'recording',
      active: false,
      outputPath: '/rec/talk.mkv',
    })
  })

  it('ne signale pas un arrêt de diffusion pendant une reconnexion', async () => {
    const obs = fakeObs(['Talk'])
    const events: unknown[] = []
    const controller = new ObsController({
      instance: 'B',
      url: 'ws://127.0.0.1:4456',
      sceneRoles: { TALK: 'Talk' },
      transport: obs.transport,
      onEvent: (event) => events.push(event),
    })
    await controller.connect()

    obs.emit('StreamStateChanged', {
      outputActive: true,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED',
    })
    // Le flux tombe et OBS le rattrape seul : annoncer un arrêt « opérateur »
    // au hub à chaque hoquet réseau serait un mensonge.
    obs.emit('StreamStateChanged', {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_RECONNECTING',
    })
    expect(controller.snapshot().streaming).toBe(true)
    expect(events.filter((event) => (event as { type: string }).type === 'streaming')).toHaveLength(1)
  })

  it('repasse déconnecté quand OBS ferme la connexion', async () => {
    const obs = fakeObs(['Capture HDMI', 'Habillage web'])
    const controller = new ObsController({
      instance: 'A',
      url: 'ws://127.0.0.1:4455',
      sceneRoles: ROLES,
      transport: obs.transport,
    })
    await controller.connect()

    obs.emit('ConnectionClosed', {})
    const state = controller.snapshot()
    expect(state.connected).toBe(false)
    // On oublie la scène : afficher la dernière connue laisserait croire que
    // la projection est encore pilotée.
    expect(state.currentSceneName).toBeNull()
  })
})

describe('état constaté à la connexion', () => {
  it('adopte la scène déjà affichée par OBS', async () => {
    const obs = fakeObs(['Capture HDMI', 'Habillage web'], 'Habillage web')
    const events: unknown[] = []
    const controller = new ObsController({
      instance: 'A',
      url: 'ws://127.0.0.1:4455',
      sceneRoles: ROLES,
      transport: obs.transport,
      onEvent: (event) => events.push(event),
    })
    await controller.connect()

    // Sans ça, la régie et la console affichent une scène vide jusqu'à la
    // première bascule — c'est-à-dire potentiellement tout un talk.
    expect(events[0]).toMatchObject({ currentRole: 'HOLD', currentSceneName: 'Habillage web' })
  })

  it('retrouve un enregistrement déjà en cours', async () => {
    const obs = fakeObs(['Talk'])
    // OBS enregistrait déjà quand l'application a redémarré.
    const transport = {
      ...obs.transport,
      call: (async (request: string, args?: Record<string, unknown>) => {
        if (request === 'GetRecordStatus') return { outputActive: true }
        return (obs.transport.call as (r: string, a?: Record<string, unknown>) => Promise<unknown>)(
          request,
          args,
        )
      }) as typeof obs.transport.call,
    }

    const events: unknown[] = []
    const controller = new ObsController({
      instance: 'B',
      url: 'ws://127.0.0.1:4456',
      sceneRoles: { TALK: 'Talk' },
      transport,
      onEvent: (event) => events.push(event),
    })
    const state = await controller.connect()

    // Repartir de « rien en cours » ferait croire à une prise perdue.
    expect(state.recording).toBe(true)
    expect(events[0]).toMatchObject({ recording: true })
  })

  it('se connecte même si OBS ignore ces requêtes', async () => {
    const obs = fakeObs(['Capture HDMI', 'Habillage web'])
    const transport = {
      ...obs.transport,
      call: (async (request: string, args?: Record<string, unknown>) => {
        if (request === 'GetRecordStatus' || request === 'GetStreamStatus') {
          throw new Error('requête inconnue')
        }
        return (obs.transport.call as (r: string, a?: Record<string, unknown>) => Promise<unknown>)(
          request,
          args,
        )
      }) as typeof obs.transport.call,
    }

    const controller = new ObsController({
      instance: 'A',
      url: 'ws://127.0.0.1:4455',
      sceneRoles: ROLES,
      transport,
    })
    // Une instance qui ne répond pas à ces requêtes ne doit pas bloquer la régie.
    await expect(controller.connect()).resolves.toMatchObject({ connected: true })
  })
})
