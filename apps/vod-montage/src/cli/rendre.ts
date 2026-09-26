/**
 * Renders a talk's intro and outro — and its whole montage when the rush is
 * there — on this machine, without a hub.
 *
 *   pnpm --filter @conference-operator/vod-montage rendre \
 *     --programme packages/program/test/fixtures/cloudnord-2026.json \
 *     --session cmq3nx20102h901ppuyjkennd [--jingle jingle.wav] [--sortie ./montage]
 *
 *   … --sidecar /rushes/2026-10-30/amphi/talk.json   (monte aussi la vidéo)
 *
 * `--apercu` writes the two pages as HTML too, playing in a browser: the
 * quickest way to work on the design.
 *
 * `--hub-data apps/hub-server/data` reads a hub's folder instead: its active
 * program, the console's settings — the loop's logo and sponsor pages, the
 * event's name — and the images it holds. `--logo <fichier|url>` forces the
 * intro's logo, for trying one before setting it in the console.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { Boucle, Sidecar } from '@conference-operator/contract'
import { normalizeProgram, programSchema, type Program } from '@conference-operator/program'
import { availableFonts, buildVodHabillage, renderVodDocument, resolveFontsFolder } from '@conference-operator/projector/server'
import { pathToFileURL } from 'node:url'
import { launchChrome } from '../chrome.js'
import { readHubData } from './hub-data.js'
import { configSchema } from '../config.js'
import { monter, renderClips } from '../pipeline.js'

const { values } = parseArgs({
  options: {
    programme: { type: 'string' },
    'hub-data': { type: 'string' },
    logo: { type: 'string' },
    boucle: { type: 'string' },
    session: { type: 'string' },
    sidecar: { type: 'string' },
    jingle: { type: 'string' },
    sortie: { type: 'string' },
    apercu: { type: 'boolean', default: false },
    lufs: { type: 'string' },
    compression: { type: 'string' },
    'passe-haut': { type: 'string' },
  },
})

const log = (message: string) => console.log(`· ${message}`)

async function main(): Promise<void> {
  if (values.session == null && values.sidecar == null) {
    throw new Error('Préciser --session <id> (intro/outro seules) ou --sidecar <fichier.json> (montage complet)')
  }
  const hub = values['hub-data'] == null ? null : readHubData(resolve(values['hub-data']))
  const program = values.programme == null ? (hub?.program ?? null) : await readProgram(values.programme)
  const boucle = values.boucle == null ? (hub?.boucle ?? null) : (JSON.parse(await readFile(values.boucle, 'utf8')) as Boucle)
  const sidecar: Sidecar = values.sidecar != null
    ? (JSON.parse(await readFile(values.sidecar, 'utf8')) as Sidecar)
    : fakeSidecar(program, values.session!)

  const built = buildVodHabillage({
    program,
    boucle,
    sidecar,
    eventName: hub?.eventName ?? null,
    localize: hub?.localize ?? ((ref) => ref),
  })
  const habillage = values.logo == null
    ? built
    : { ...built, event: { ...built.event, logoUrl: /^https?:\/\//.test(values.logo) ? values.logo : resolve(values.logo) } }
  log(`logo de l’intro : ${habillage.event.logoUrl ?? 'aucun'}`)

  const audioOptions = configSchema.shape.audio.parse({
    lufs: values.lufs,
    compression: values.compression,
    highpassHz: values['passe-haut'],
  })
  const out = resolve(values.sortie ?? `montage-${sidecar.sessionId ?? 'talk'}`)
  await mkdir(out, { recursive: true })
  const jingle = values.jingle == null ? null : resolve(values.jingle)

  if (values.apercu) {
    const folder = resolveFontsFolder()
    const fonts = folder == null ? undefined : { base: pathToFileURL(folder).href, files: availableFonts(folder) }
    for (const clip of ['intro', 'outro'] as const) {
      await writeFile(join(out, `${clip}.html`), renderVodDocument({ clip, habillage, fonts }), 'utf8')
    }
    log(`aperçus : ${join(out, 'intro.html')}, ${join(out, 'outro.html')}`)
  }

  const profile = await mkdtemp(join(tmpdir(), 'vod-montage-'))
  const chrome = await launchChrome(process.env.CHROME ?? 'google-chrome', profile)
  const started = Date.now()
  try {
    if (values.sidecar == null) {
      const clips = await renderClips({ chrome, habillage, jingle, workDir: out, lufs: audioOptions.lufs, log })
      log(`intro ${clips.intro.durationMs / 1000} s → ${clips.intro.file}`)
      log(`outro ${clips.outro.durationMs / 1000} s → ${clips.outro.file}`)
    } else {
      let last = ''
      const result = await monter({
        chrome,
        habillage,
        sidecar,
        folder: dirname(resolve(values.sidecar)),
        jingle,
        workDir: out,
        output: join(out, `${sidecar.sessionId ?? 'talk'}.mp4`),
        audio: audioOptions,
        log,
        onStep: (etape) => {
          if (etape !== last) log(`${etape}…`)
          last = etape
        },
      })
      log(`montage ${(result.durationMs / 60_000).toFixed(1)} min → ${result.output}`)
      log(`coupe : ${JSON.stringify(result.coupe)}`)
      log(`son : ${JSON.stringify(result.audio)}`)
    }
    log(`terminé en ${((Date.now() - started) / 1000).toFixed(1)} s`)
  } finally {
    await chrome.stop()
    await rm(profile, { recursive: true, force: true })
  }
}

/** A conference-center export, or the hub's normalised program. */
async function readProgram(file: string): Promise<Program> {
  const json: unknown = JSON.parse(await readFile(file, 'utf8'))
  const normalised = programSchema.safeParse(json)
  return normalised.success ? (normalised.data as Program) : normalizeProgram(json)
}

/** What a room would have written for this session — enough for the two clips. */
function fakeSidecar(program: Program | null, sessionId: string): Sidecar {
  const session = program?.sessions.find((s) => s.id === sessionId)
  if (session == null) throw new Error(`Session ${sessionId} absente du programme (--programme)`)
  return {
    sessionId,
    title: session.title,
    speakers: session.speakers.map((s) => ({ name: s.name, company: s.company })),
    roomId: session.roomId,
    trackTitle: null,
    category: session.category?.name ?? null,
    startedAt: session.startsAt,
    endedAt: session.endsAt ?? session.startsAt,
    durationMs: 0,
    markers: [],
    videoFile: null,
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
