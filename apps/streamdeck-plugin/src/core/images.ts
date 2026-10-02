import type { DisplayPayload } from '@conference-operator/contract/room-display'
import type { ButtonFace, ButtonSettings } from './buttons.js'

/**
 * The key's picture, drawn for what the key **does** — not one picture per kind.
 *
 * A "Démarrer" and a "Terminer" key are the same action with two settings; with
 * one picture they both showed ▶, and ending a talk looked like starting one. The
 * pictogram therefore follows the setting (the scene, the screen, the mark) and,
 * where the press changes meaning, the state: a recording key shows ● while idle
 * and ■ while recording — what pressing it will do.
 *
 * Pure, and painted at runtime (`setImage`): the manifest's images are only the
 * defaults the action list shows.
 */

/** 24×24 pictograms, white strokes. */
const G = {
  play: '<path d="M8 5l11 7-11 7z" fill="#fff"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="#fff"/>',
  record: '<circle cx="12" cy="12" r="7" fill="#fff"/>',
  playNoRec: '<path d="M5 5l9 7-9 7z" fill="#fff"/><circle cx="18" cy="17" r="3.5"/><path d="M15.5 19.5l5-5"/>',
  broadcast: '<circle cx="12" cy="12" r="2" fill="#fff"/><path d="M8 8a6 6 0 0 0 0 8M16 8a6 6 0 0 1 0 8M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>',
  overlay: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 14h18"/><path d="M6 16h7"/>',
  relay: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  person: '<circle cx="12" cy="7" r="3.5"/><path d="M5 21a7 7 0 0 1 14 0"/>',
  camera: '<rect x="3" y="7" width="13" height="10" rx="2"/><path d="M16 11l5-3v8l-5-3"/>',
  slides: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v4M8 20h8M7 8h6M7 11h10"/>',
  loop: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/>',
  hourglass: '<path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9"/>',
  bubble: '<path d="M4 5h16v11H9l-5 4z"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1" fill="#fff"/><circle cx="4" cy="12" r="1" fill="#fff"/><circle cx="4" cy="18" r="1" fill="#fff"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  thumb: '<path d="M7 11v9H4v-9zM7 11l4-8a2 2 0 0 1 2 2v4h6a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.8 20H7"/>',
  question: '<path d="M4 5h16v11H9l-5 4z"/><path d="M10 8.5a2 2 0 1 1 2.5 2c-.4.2-.5.5-.5.9V12M12 14h.01"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  hash: '<path d="M9 3L7 21M17 3l-2 18M4 8h17M3 16h17"/>',
  markStart: '<path d="M7 4v16M7 4h4M7 20h4"/><path d="M13 12h8M18 9l3 3-3 3"/>',
  markEnd: '<path d="M17 4v16M17 4h-4M17 20h-4"/><path d="M3 12h8M8 9l3 3-3 3"/>',
  bookmark: '<path d="M7 3h10v18l-5-4-5 4z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  micOff: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/><path d="M3 3l18 18"/>',
  clear: '<path d="M4 5h16v11H9l-5 4z"/><path d="M10 8l4 4M14 8l-4 4"/>',
  pulse: '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
  swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
} as const
type Glyph = keyof typeof G

const SCENE_GLYPHS: Record<string, Glyph> = {
  LIVE: 'broadcast',
  HOLD: 'overlay',
  RELAY: 'relay',
  TALK: 'person',
  CAM_ONLY: 'camera',
  SLIDES_ONLY: 'slides',
}

const DISPLAY_GLYPHS: Record<string, Glyph> = {
  loop: 'loop',
  countdown: 'hourglass',
  message: 'bubble',
  programme: 'list',
  agenda: 'calendar',
  sponsors: 'star',
  feedback: 'thumb',
  question: 'question',
  wall: 'grid',
  wallsio: 'hash',
  live: 'broadcast',
}

/** The ground when the key is "on": the colour of what is happening. */
const RED = '#e11d48'
const BLUE = '#5b7cfa'
const GREEN = '#059669'
const ORANGE = '#d97706'
const DARK = '#1d2334'
const GREY = '#2b3348'

/** Which pictogram, on which ground, for this key now. */
export function pictogram(
  settings: ButtonSettings,
  face: ButtonFace,
  payload: DisplayPayload | null,
): { glyph: Glyph; ground: string } {
  if (face.offline) return { glyph: glyphOf(settings, face, payload), ground: GREY }
  const on = (color: string) => (face.on ? color : DARK)
  switch (settings.kind) {
    case 'scene':
      return { glyph: SCENE_GLYPHS[settings.role ?? ''] ?? 'slides', ground: on(settings.role === 'LIVE' ? RED : BLUE) }
    case 'scene-toggle':
      return { glyph: glyphOf(settings, face, payload), ground: on(RED) }
    case 'display':
      return { glyph: DISPLAY_GLYPHS[settings.mode ?? ''] ?? 'loop', ground: on(BLUE) }
    case 'recording':
      return { glyph: face.on ? 'stop' : 'record', ground: on(RED) }
    case 'mark':
      return { glyph: glyphOf(settings, face, payload), ground: on(GREEN) }
    case 'stream':
      return { glyph: face.on ? 'stop' : 'broadcast', ground: on(RED) }
    case 'mic':
      return { glyph: face.on ? 'micOff' : 'mic', ground: on(ORANGE) }
    case 'session':
      return { glyph: glyphOf(settings, face, payload), ground: settings.which === 'end' ? on(RED) : on(BLUE) }
    case 'message-clear':
      return { glyph: 'clear', ground: on(ORANGE) }
    case 'status':
      // The status key's "off" means something is down: said in red, not in grey.
      return { glyph: 'pulse', ground: face.on ? GREEN : '#9f1239' }
  }
}

function glyphOf(settings: ButtonSettings, face: ButtonFace, payload: DisplayPayload | null): Glyph {
  switch (settings.kind) {
    case 'scene':
      return SCENE_GLYPHS[settings.role ?? ''] ?? 'slides'
    case 'scene-toggle':
      // The swap itself: the title already says which scene is on air, and a
      // pictogram of the *next* one under it read as a contradiction.
      return 'swap'
    case 'display':
      return DISPLAY_GLYPHS[settings.mode ?? ''] ?? 'loop'
    case 'recording':
      return face.on ? 'stop' : 'record'
    case 'mark':
      return settings.mark === 'debut' ? 'markStart' : settings.mark === 'fin' ? 'markEnd' : 'bookmark'
    case 'stream':
      return face.on ? 'stop' : 'broadcast'
    case 'mic':
      return face.on ? 'micOff' : 'mic'
    case 'session':
      return settings.which === 'end' ? 'stop' : settings.which === 'start-norec' ? 'playNoRec' : 'play'
    case 'message-clear':
      return 'clear'
    case 'status':
      return 'pulse'
  }
}

/** The key's SVG, 144 px drawn on a 72 grid: pictogram above, room for the title below. */
export function keySvg(glyph: Glyph, ground: string, dim = false): string {
  const stroke = dim ? '#97a1bd' : '#fff'
  const shape = G[glyph].replace(/#fff/g, stroke)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 72 72">` +
    `<rect width="72" height="72" rx="10" fill="${ground}"/>` +
    `<g transform="translate(23 8) scale(${26 / 24})" fill="none" stroke="${stroke}" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round">${shape}</g></svg>`
  )
}

/** What `setImage` takes: the SVG, base64, with its type declared. */
export function keyImage(settings: ButtonSettings, face: ButtonFace, payload: DisplayPayload | null): string {
  const { glyph, ground } = pictogram(settings, face, payload)
  return `data:image/svg+xml;base64,${Buffer.from(keySvg(glyph, ground, face.offline)).toString('base64')}`
}
