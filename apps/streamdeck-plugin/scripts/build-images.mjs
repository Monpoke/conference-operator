import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * The plugin's images, written into the `.sdPlugin` folder — committed, like
 * room-client's icons: run again only when a drawing changes.
 *
 * - the plugin icon, PNG 256/512, from room-client's master (`magick` needed);
 * - per action, the list icon (white on transparent, 20/40) and the key's two
 *   states (72/144): "off" on the dark ground, "on" in the colour that says
 *   what is happening — red on air, orange for a muted source, green when all is
 *   well. The pictogram sits in the upper half; the title the plugin writes goes
 *   underneath (`TitleAlignment: bottom` in the manifest).
 */
const root = resolve(import.meta.dirname, '..')
const plugin = join(root, 'io.github.monpoke.conference-operator.sdPlugin', 'imgs')

/** 24×24 pictograms, white strokes. */
const GLYPHS = {
  scene: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>',
  display: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M7 21h10"/><path d="M6 8h12M6 12h8"/>',
  recording: '<circle cx="12" cy="12" r="7" fill="#fff"/>',
  mark: '<path d="M6 21V4M6 4h11l-2 4 2 4H6"/>',
  stream: '<circle cx="12" cy="12" r="2" fill="#fff"/><path d="M8 8a6 6 0 0 0 0 8M16 8a6 6 0 0 1 0 8M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  session: '<path d="M8 5l11 7-11 7z"/>',
  'message-clear': '<path d="M4 5h16v11H9l-5 4z"/><path d="M10 8l4 4M14 8l-4 4"/>',
  status: '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
}

/** The "on" ground of each kind; "off" is the console's dark surface. */
const ON = {
  scene: '#5b7cfa',
  display: '#5b7cfa',
  recording: '#e11d48',
  mark: '#059669',
  stream: '#e11d48',
  mic: '#d97706',
  session: '#5b7cfa',
  'message-clear': '#d97706',
  status: '#059669',
}
const OFF = '#1d2334'
/** The status key's "off" means something is down: said in red, not in grey. */
const OFF_OVERRIDE = { status: '#9f1239' }

function glyph(kind, size, x, y) {
  return `<g transform="translate(${x} ${y}) scale(${size / 24})" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[kind]}</g>`
}

function key(kind, ground, px) {
  // Drawn on a 72 grid, scaled for @2x.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 72 72"><rect width="72" height="72" rx="10" fill="${ground}"/>${glyph(kind, 26, 23, 8)}</svg>\n`
}

function icon(kind, px) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24">${glyph(kind, 24, 0, 0)}</svg>\n`
}

for (const kind of Object.keys(GLYPHS)) {
  const folder = join(plugin, 'actions', kind)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'icon.svg'), icon(kind, 20))
  writeFileSync(join(folder, 'icon@2x.svg'), icon(kind, 40))
  const off = OFF_OVERRIDE[kind] ?? OFF
  writeFileSync(join(folder, 'off.svg'), key(kind, off, 72))
  writeFileSync(join(folder, 'off@2x.svg'), key(kind, off, 144))
  writeFileSync(join(folder, 'on.svg'), key(kind, ON[kind], 72))
  writeFileSync(join(folder, 'on@2x.svg'), key(kind, ON[kind], 144))
}

mkdirSync(join(plugin, 'plugin'), { recursive: true })
writeFileSync(join(plugin, 'plugin', 'category.svg'), icon('display', 28))
writeFileSync(join(plugin, 'plugin', 'category@2x.svg'), icon('display', 56))
const master = resolve(root, '..', 'room-client', 'build', 'icon.png')
execFileSync('magick', [master, '-resize', '256x256', '-strip', join(plugin, 'plugin', 'icon.png')])
execFileSync('magick', [master, '-resize', '512x512', '-strip', join(plugin, 'plugin', 'icon@2x.png')])
console.log(`images written to ${plugin}`)
