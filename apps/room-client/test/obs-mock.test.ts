import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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
