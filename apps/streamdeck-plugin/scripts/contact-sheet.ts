import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { faceOf, type ButtonSettings } from '../src/core/buttons.js'
import { keySvg, pictogram } from '../src/core/images.js'

/**
 * Every key variant on one sheet, to look at the pictures together.
 *
 *   npx tsx scripts/contact-sheet.ts <dossier>   → <dossier>/sheet.svg
 */
const out = process.argv[2] ?? '.'
const payload = {
  state: {
    mode: 'countdown',
    sceneRole: 'LIVE',
    recording: true,
    streaming: false,
    connectivity: 'ONLINE',
    currentSession: { title: 'Le futur du cloud' },
    targetSession: { id: 't', title: 'Le futur du cloud', startsAtMs: Date.now(), endsAtMs: null },
    message: { text: 'x', level: 'info', expiresAtMs: null },
    audioInputs: [{ name: 'Micro', muted: { A: true, B: true } }],
    serverTimeOffsetMs: 0,
    pinnedSessionId: null,
  },
  diagnostics: {
    recording: { active: true, startedAtMs: Date.now() - 754_000, markers: 2, editing: { startMs: 1, endMs: null } },
    obs: { A: { connected: true }, B: { connected: true } },
  },
} as never

const variants: ButtonSettings[] = [
  { kind: 'scene', role: 'LIVE' },
  { kind: 'scene', role: 'HOLD' },
  { kind: 'scene', role: 'RELAY' },
  { kind: 'scene-toggle' },
  { kind: 'display', mode: 'loop' },
  { kind: 'display', mode: 'countdown' },
  { kind: 'display', mode: 'message' },
  { kind: 'display', mode: 'programme' },
  { kind: 'recording' },
  { kind: 'mark', mark: 'debut' },
  { kind: 'mark', mark: 'fin' },
  { kind: 'mark', mark: 'chapitre' },
  { kind: 'stream' },
  { kind: 'mic', input: 'Micro' },
  { kind: 'session', which: 'start' },
  { kind: 'session', which: 'start-norec' },
  { kind: 'session', which: 'end' },
  { kind: 'message-clear' },
  { kind: 'status' },
]

const cell = 160
const perRow = 5
const rows = Math.ceil(variants.length / perRow)
const parts = variants.map((settings, index) => {
  const face = faceOf(settings, payload, Date.now())
  const { glyph, ground } = pictogram(settings, face, payload)
  const svg = keySvg(glyph, ground).replace('<svg ', `<svg x="${(index % perRow) * cell + 8}" y="${Math.floor(index / perRow) * cell + 8}" `)
  const title = face.title
    .split('\n')
    .map((line, i) => `<text x="${(index % perRow) * cell + 80}" y="${Math.floor(index / perRow) * cell + 112 + i * 14}" font-family="sans-serif" font-size="12" fill="#fff" text-anchor="middle">${line}</text>`)
    .join('')
  return svg + title
})
mkdirSync(out, { recursive: true })
writeFileSync(
  join(out, 'sheet.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" width="${perRow * cell}" height="${rows * cell}"><rect width="100%" height="100%" fill="#000"/>${parts.join('')}</svg>`,
)
