import { join } from 'node:path'
import { app, BrowserWindow, dialog, safeStorage, screen } from 'electron'
import { RoomApp } from '../core/room-app.js'
import { formatLogLine } from '../core/console-log.js'
import { createMockObsTransport } from '../core/obs-mock.js'
import { modeOffset, readMode } from '../core/mode.js'
import { loadOrCreateClientId } from './identity.js'
import { createSecretVault } from './secrets.js'
import { resolveHubAddress } from './hub-address.js'
import { askHubAddress } from './hub-window.js'

/**
 * The Electron shell: deliberately thin.
 *
 * All the logic lives in `core/`, with no dependency on Electron, so it can be
 * tested with no screen and no OBS instance. This file only opens the windows and
 * wires up the data paths.
 */

/**
 * The execution mode, read once at startup.
 *
 * `MODE=dev` runs a whole talk without installing OBS; outside that mode, the
 * development conveniences are neutralized even if they linger in the
 * environment — a forgotten `OBS_MOCK=1` is a day filmed by an OBS instance that
 * does not exist.
 */
const MODE = readMode()

async function main(): Promise<void> {
  await app.whenReady()

  /**
   * The close latch, set before the first window.
   *
   * Between the address screen — closed as soon as the entry is validated — and
   * the opening of the projection, the application owns no window. Electron then
   * emits `window-all-closed`, whose default behaviour is to quit: without this
   * latch, the room would switch off between two windows.
   */
  let startupFinished = false
  app.on('window-all-closed', () => {
    if (startupFinished) app.quit()
  })

  const dataDir = app.getPath('userData')
  const clientId = loadOrCreateClientId(join(dataDir, 'client-id'))

  // Before everything else: with no hub, there is neither a room to choose nor a
  // program to project. Asked once per machine, then remembered.
  const hubOrigin = await resolveHubAddress({
    path: join(dataDir, 'hub'),
    ask: (initialValue) => askHubAddress({ initialValue }),
    onLog: (level, message) => console.error(formatLogLine(level, message)),
  })
  if (hubOrigin == null) {
    console.error(formatLogLine('error', "Aucune adresse de hub : l'application s'arrête"))
    app.quit()
    return
  }

  const vault = createSecretVault(join(dataDir, 'jeton'), safeStorage, (message) =>
    console.warn(message),
  )

  for (const { variable, reason } of MODE.ignores) {
    console.error(formatLogLine('error', `${variable} ignoré : ${reason}`))
  }
  if (MODE.mode === 'dev') {
    console.warn(formatLogLine('warn', 'MODE DÉVELOPPEMENT — à ne pas laisser le jour J'))
  }

  const room = new RoomApp({
    dataDir,
    mode: MODE.mode,
    hubOrigin,
    clientId,
    roomId: process.env.ROOM_ID,
    regieViteOrigin: process.env.REGIE_VITE_ORIGIN ?? null,
    obsTransportFactory: MODE.obsSimulated
      ? (instance, scenes) =>
          createMockObsTransport({
            instance,
            // See `dev-headless.ts`: the simulator carries the room's scenes,
            // without which it complains about names only it does not know.
            scenes,
            recordingDir: join(dataDir, 'enregistrements'),
            onLog: (message) => console.log(message),
          })
      : undefined,
    /**
     * The folder picker, supplied by Electron only.
     *
     * `dev:headless` runs under bare Node and does not supply it: the control app
     * then hides the button, because a button that does not answer costs more than
     * a field to fill in by hand.
     *
     * `defaultPath` on the folder already typed: correcting a path is almost
     * always changing one branch of it, not starting again from the root.
     */
    chooseFolder: async (initial) => {
      const result = await dialog.showOpenDialog({
        title: 'Dossier des VOD',
        properties: ['openDirectory', 'createDirectory'],
        ...(initial == null || initial === '' ? {} : { defaultPath: initial }),
      })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    readToken: () => vault.read(),
    writeToken: (token) => vault.write(token),
    onLog: (level, message, context) =>
      console[level === 'error' ? 'error' : 'log'](formatLogLine(level, message, context)),
    onPairingCode: (code) => {
      console.log(`Code d'appairage : ${code.user_code} — à approuver dans l'admin du hub`)
    },
  })

  // The local simulated time, if there is one: set as an offset, exactly as the
  // hub will do as soon as it answers — and it will take over.
  const offset = modeOffset(MODE)
  if (offset !== 0) room.runtime.setClockOffset(offset, true)

  // The screen first: the room must project even if the hub never answers.
  const displayUrl = await room.startDisplay()
  wireScreenOpenings(openControlWindow(`${displayUrl}/regie`))
  // The control app is open: closing the last window means "we switch off" again.
  startupFinished = true

  // The hub can be started after the rooms: we will join it by ourselves.
  room.startSupervision()

  const token = await room.ensurePaired()
  if (token != null) {
    await room.connectHub(token)
    await room.connectObs()
  }

  app.on('before-quit', () => {
    // With no explicit close, the reconnection timers keep the process alive and
    // the application never closes.
    void room.close()
  })
}

/**
 * The control window, on the operator's screen.
 *
 * The only one open at startup, and before any network call: the operator must
 * have control over OBS and over the screen even if the hub never answers. The
 * other screens open on demand, from its "Écrans" menu.
 */
function openControlWindow(url: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    // Shown only once painted: maximizing an already visible window makes it jump
    // from one format to another before the operator's eyes.
    show: false,
    backgroundColor: '#0d0f16',
    autoHideMenuBar: true,
    /**
     * A boot title only.
     *
     * The page replaces it with "Régie — <event>" from the first render, with the
     * name the hub decided. Writing it here would freeze it into the binary
     * installed on the machine — that is, for every edition it will serve
     * afterwards.
     */
    title: 'Régie de salle',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  /**
   * Maximized from the outset.
   *
   * The page is composed so that **nothing that commands scrolls**: everything
   * that triggers a decision fits in the window's height. Opened at 860 px on an
   * operator's monitor, that promise is paid for in cramped buttons, for space
   * left empty around them. The dimensions above stay the restored format, after
   * a click on "minimize".
   */
  wireFullScreen(window)
  window.once('ready-to-show', () => {
    // Maximized before being shown, but **once painted**: on a window that is
    // still hidden, the request goes to a window manager that does not know the
    // window yet, and falls through silently — the control app then opened at its
    // fallback dimensions.
    window.maximize()
    window.show()
  })
  void window.loadURL(url)
  return window
}

/**
 * The screens opened from the control app's "Écrans" menu.
 *
 * The projection is no longer opened at startup — one more window on the
 * operator's screen, for a fallback that almost never serves. But when it does
 * serve, it serves fast: opened from the menu, it must find exactly the placement
 * it had at launch — full screen on the video projector output — instead of the
 * default window a plain `target="_blank"` would produce, set in the middle of the
 * control screen.
 *
 * The menu's other screens — overlays, live banner, public wall — open normally:
 * they go into OBS or onto a phone, not onto a projector.
 */
function wireScreenOpenings(control: BrowserWindow): void {
  control.webContents.setWindowOpenHandler(({ url }) => {
    if (pathOf(url) !== '/display/projector') return { action: 'allow' }
    openProjectorWindow(url)
    return { action: 'deny' }
  })
}

function pathOf(url: string): string | null {
  try {
    return new URL(url).pathname
  } catch {
    return null
  }
}

/**
 * The full-screen toggle on the keyboard: **Alt+Enter**, and F11.
 *
 * Set in the main process, not in the page: the screens are served over HTTP by
 * the local server, with no preload, and therefore have no way of calling
 * Electron. `before-input-event` sees the keystroke before the page, which makes
 * the shortcut independent of what has focus — an open input field must not
 * swallow it.
 *
 * Alt+Enter is free: the control app already lets through any key held with Alt,
 * which belongs to the browser. Escape is not taken, though: the page uses it to
 * close its modals, and taking it away would leave full screen instead of closing
 * the one being looked at.
 */
function wireFullScreen(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key !== 'F11' && !(input.key === 'Enter' && input.alt)) return
    event.preventDefault()
    window.setFullScreen(!window.isFullScreen())
  })
}

/**
 * The projection window, on the secondary screen when there is one.
 *
 * Serves as a fallback: if OBS-A crashes, the operator switches to it and the
 * projection carries on with nothing to reconfigure. Opened on demand from the
 * control app's "Écrans" menu.
 */
function openProjectorWindow(url: string): BrowserWindow {
  const displays = screen.getAllDisplays()
  const target = displays.find((display) => display.id !== screen.getPrimaryDisplay().id)

  const window = new BrowserWindow({
    x: target?.bounds.x,
    y: target?.bounds.y,
    fullscreen: target != null,
    width: 1920,
    height: 1080,
    backgroundColor: '#10121a',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  // On a single-screen machine, it opens as a window: the keyboard full screen is
  // then what makes the fallback usable in front of a room.
  wireFullScreen(window)
  void window.loadURL(url)
  return window
}

void main()
