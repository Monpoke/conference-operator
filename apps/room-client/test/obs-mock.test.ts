import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeProgram } from '@cloudnord/program'
import { createMockObsTransport, SCENES_PAR_DEFAUT } from '../src/core/obs-mock.js'
import { ObsController } from '../src/core/obs.js'
import { LocalStore } from '../src/core/store.js'
import { RoomRuntime } from '../src/core/runtime.js'
import { RecordingSession } from '../src/core/recording.js'

const program = normalizeProgram(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
      'utf8',
    ),
  ),
)
const TRACK_1 = 'track-1-teilhard-de-chardin'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-mock-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('OBS simulé', () => {
  /**
   * Le cas signalé en régie : la captation était déjà « en cours » à
   * l'allumage, sans que personne ne l'ait lancée, et il fallait l'arrêter
   * avant de pouvoir en démarrer une.
   *
   * Adopter la prise d'OBS à la connexion existe pour l'appli redémarrée au
   * milieu d'un talk. Une instance simulée n'a pas de talk derrière elle : ce
   * qu'elle garde d'une connexion à l'autre n'est le souvenir d'aucune vidéo.
   */
  it("coupe une captation en cours au lieu de l'adopter", async () => {
    const transport = createMockObsTransport({ instance: 'B', recordingDir: join(dir, 'rec') })
    await transport.call('StartRecord')

    const obs = new ObsController({
      instance: 'B',
      url: 'mock',
      sceneRoles: {},
      transport,
    })
    const etat = await obs.connect()

    expect(etat.recording).toBe(false)
    // Coupée pour de bon, et pas seulement masquée : sans ça, le prochain
    // « Enregistrer » échouerait sur un « déjà en cours » que l'écran contredit.
    expect(await transport.call('GetRecordStatus')).toMatchObject({ outputActive: false })
  })

  it("adopte la captation d'une instance réelle", async () => {
    /**
     * Le garde-fou du garde-fou : la règle ne vaut que pour le simulé. Une
     * vraie prise en cours retrouvée au redémarrage doit rester adoptée, sinon
     * la régie annoncerait une VOD perdue qui tourne pourtant.
     */
    const transport = createMockObsTransport({ instance: 'B', recordingDir: join(dir, 'rec') })
    await transport.call('StartRecord')
    const commeReel = { ...transport, simule: false }

    const obs = new ObsController({
      instance: 'B',
      url: 'ws://127.0.0.1:4456',
      sceneRoles: {},
      transport: commeReel,
    })

    expect((await obs.connect()).recording).toBe(true)
  })

  it('se déclare simulé, pour que la régie puisse le dire', async () => {
    // Rien ne distingue à l'écran un enregistrement simulé d'un vrai : le
    // transport porte l'information lui-même, plutôt qu'une variable
    // d'environnement relue ailleurs, qui pourrait le contredire.
    const simule = new ObsController({
      instance: 'A',
      url: 'mock',
      sceneRoles: {},
      transport: createMockObsTransport({ instance: 'A', recordingDir: join(dir, 'rec') }),
    })
    expect(simule.snapshot().simulated).toBe(true)

    const reel = new ObsController({
      instance: 'A',
      url: 'ws://127.0.0.1:4455',
      sceneRoles: {},
      transport: {
        connect: async () => {},
        disconnect: async () => {},
        call: (async () => ({})) as never,
        on: () => {},
      },
    })
    expect(reel.snapshot().simulated).toBe(false)
  })

  it('expose les mêmes scènes que le mapping posé à la création d\'une salle', async () => {
    const controller = new ObsController({
      instance: 'A',
      url: 'mock',
      sceneRoles: {
        LIVE: SCENES_PAR_DEFAUT.A[0]!,
        HOLD: SCENES_PAR_DEFAUT.A[1]!,
      },
      transport: createMockObsTransport({ instance: 'A', recordingDir: join(dir, 'rec') }),
    })

    const state = await controller.connect()
    // Sans cet accord, la régie afficherait des rôles en rouge dès le démarrage
    // du mode simulé — et on croirait à un bug.
    expect(state.unresolvedRoles).toEqual([])
    expect(state.currentRole).toBe('HOLD')
  })

  it('confirme la bascule par événement, comme le vrai OBS', async () => {
    const controller = new ObsController({
      instance: 'A',
      url: 'mock',
      sceneRoles: { LIVE: SCENES_PAR_DEFAUT.A[0]!, HOLD: SCENES_PAR_DEFAUT.A[1]! },
      transport: createMockObsTransport({ instance: 'A', recordingDir: join(dir, 'rec') }),
    })
    await controller.connect()
    await controller.setRole('LIVE')

    // L'événement est asynchrone : l'état ne peut pas être juste immédiatement,
    // exactement comme avec OBS.
    await sleep(30)
    expect(controller.snapshot().currentRole).toBe('LIVE')
  })

  it('refuse une scène inconnue', async () => {
    const transport = createMockObsTransport({ instance: 'A', recordingDir: join(dir, 'rec') })
    await expect(transport.call('SetCurrentProgramScene', { sceneName: 'Inventée' })).rejects.toThrow(
      /Scène inconnue/,
    )
  })

  it('produit un vrai fichier et permet d\'obtenir un sidecar', async () => {
    const recDir = join(dir, 'rec')
    const store = new LocalStore(':memory:')
    const runtime = new RoomRuntime(store)
    const transport = createMockObsTransport({ instance: 'B', recordingDir: recDir })
    const obs = new ObsController({
      instance: 'B',
      url: 'mock',
      sceneRoles: { TALK: SCENES_PAR_DEFAUT.B[0]! },
      transport,
    })
    await obs.connect()

    let chemin: string | null = null
    transport.on('RecordStateChanged', ((payload: { outputActive: boolean; outputPath?: string }) => {
      if (!payload.outputActive && payload.outputPath != null) chemin = payload.outputPath
    }) as never)

    const { readFile, rename, writeFile } = await import('node:fs/promises')
    const session = new RecordingSession({
      setFilenameFormat: (format) => obs.setProfileParameter('Output', 'FilenameFormatting', format),
      startRecord: () => obs.startRecording(),
      stopRecord: () => obs.stopRecording(),
      fs: {
        rename: (from, to) => rename(from, to),
        writeFile: (path, contents) => writeFile(path, contents, 'utf8'),
        exists: async (path) => readFile(path).then(() => true, () => false),
      },
      now: () => Date.now(),
      correctedNow: () => runtime.correctedNow(),
    })

    const talk = program.sessions.find((s) => s.id === 'cmqav0qto03qe01nsitbr18cn')!
    await session.start({ session: talk, roomId: TRACK_1, roomSlug: 'track1', timezone: 'Europe/Paris' })
    session.mark('démo')
    const attente = new Promise<string | null>((resolve) => setTimeout(() => resolve(chemin), 60))
    const resultat = await session.stop(() => attente)

    // Le fichier existe réellement : sans ça, la chaîne s'arrêterait au
    // renommage et on ne verrait jamais le sidecar — la partie qu'on veut observer.
    expect(resultat.videoPath).toContain('2026-10-30_track1_1100_honeyswamp')
    const fichiers = readdirSync(recDir)
    expect(fichiers.filter((f) => f.endsWith('.mkv'))).toHaveLength(1)
    expect(fichiers.filter((f) => f.endsWith('.json'))).toHaveLength(1)

    const sidecar = JSON.parse(readFileSync(resultat.sidecarPath!, 'utf8')) as { markers: unknown[] }
    expect(sidecar.markers).toHaveLength(1)
    store.close()
  })

  it("n'écrase jamais un fichier déjà là", async () => {
    /**
     * Le poste simulé écrit dans le dossier des captations, et deux arrêts sur
     * la même conférence donnent le même nom de fichier. Anecdotique tant que
     * ce dossier ne contenait que des fichiers de cinquante octets ; depuis que
     * la régie sait les relire, on y dépose de vraies vidéos — et un
     * « Arrêter » de trop les effaçait sans rien dire.
     */
    const rec = join(dir, 'rec')
    mkdirSync(rec, { recursive: true })
    const transport = createMockObsTransport({ instance: 'B', recordingDir: rec })
    await transport.call('SetProfileParameter', {
      parameterCategory: 'Output',
      parameterName: 'FilenameFormatting',
      parameterValue: 'keynote',
    })
    writeFileSync(join(rec, 'keynote.mkv'), 'une vraie vidéo, posée à la main')

    await transport.call('StartRecord')
    await transport.call('StopRecord')

    expect(readFileSync(join(rec, 'keynote.mkv'), 'utf8')).toBe('une vraie vidéo, posée à la main')
    expect(readdirSync(rec).sort()).toEqual(['keynote-2.mkv', 'keynote.mkv'])
  })

  it('simule la diffusion et sa télémétrie', async () => {
    const transport = createMockObsTransport({ instance: 'B', recordingDir: join(dir, 'rec') })
    const obs = new ObsController({ instance: 'B', url: 'mock', sceneRoles: {}, transport })
    await obs.connect()

    expect((await obs.streamStatus()).bitrateKbps).toBe(0)
    await obs.startStream()
    expect((await obs.streamStatus()).bitrateKbps).toBeGreaterThan(0)
  })

  it('refuse deux enregistrements simultanés', async () => {
    const transport = createMockObsTransport({ instance: 'B', recordingDir: join(dir, 'rec') })
    await transport.call('StartRecord')
    await expect(transport.call('StartRecord')).rejects.toThrow(/déjà en cours/)
  })
})
