import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * `build/icon.png` and `build/icon.ico`, from `build/icon.svg`.
 *
 * Not part of the build: the two outputs are committed, and electron-builder
 * picks them up from `buildResources` on its own — `icon.png` for Linux (the
 * AppImage and the desktop entry), `icon.ico` for the Windows executable, the
 * installer and the shortcuts. Run it again only when the drawing changes.
 *
 * Two tools the repository does not install, both of which a developer machine
 * has: Chrome, headless, which renders SVG exactly as a browser does (gradients
 * included, where ImageMagick's own renderer approximates), and ImageMagick for
 * the resampling and the `.ico` container. `CHROME` overrides the binary.
 */
const chrome = process.env.CHROME ?? 'google-chrome'
const build = resolve(import.meta.dirname, '../build')
const scratch = mkdtempSync(join(tmpdir(), 'room-icons-'))

try {
  const master = join(scratch, 'icon-1024.png')
  execFileSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--default-background-color=00000000',
    '--window-size=1024,1024',
    `--screenshot=${master}`,
    pathToFileURL(join(build, 'icon.svg')).href,
  ], { stdio: 'ignore' })

  execFileSync('magick', [master, '-strip', join(build, 'icon.png')])

  // Every size Windows asks for, from the 16 px of the title bar to the 256 px
  // of Explorer's large tiles. Each is resampled from the master rather than left
  // to Windows to shrink the largest: a 16 px downscaled on the fly loses the
  // "on air" light.
  execFileSync('magick', [
    master,
    '-define', 'icon:auto-resize=256,128,64,48,32,24,16',
    join(build, 'icon.ico'),
  ])
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
