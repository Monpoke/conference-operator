import { join } from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import { renderHubAddressPage } from '../core/hub-address-page.js'
import { probeConnectivity } from '../core/connectivity.js'
import { normalizeHubAddress } from './hub-address.js'

export interface HubWindowOptions {
  initialValue: string
  /** Injectable for the tests; probes `/health` by default. */
  probe?: (origin: string) => Promise<boolean>
}

/**
 * Asks for the hub's address and returns the validated origin.
 *
 * `null` when the operator closes the window without validating: there is then no
 * room to start, and the caller quits.
 *
 * The IPC channel names `hub:tester` and `hub:valider` are a frozen contract with
 * the preload bridge: they do not get renamed.
 */
export function askHubAddress(options: HubWindowOptions): Promise<string | null> {
  const probe = options.probe ?? probeHub

  const browserWindow = new BrowserWindow({
    width: 620,
    height: 480,
    resizable: false,
    backgroundColor: '#0b0d14',
    autoHideMenuBar: true,
    title: 'Régie de salle',
    webPreferences: {
      // The path from the bundle: `dist/main.cjs` and `dist/preload-hub.cjs` are
      // neighbours, in the package as in development.
      preload: join(__dirname, 'preload-hub.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  return new Promise<string | null>((resolve) => {
    let settled = false

    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      ipcMain.removeHandler('hub:tester')
      ipcMain.removeHandler('hub:valider')
      resolve(value)
    }

    ipcMain.handle('hub:tester', async (_event, address: unknown) => {
      if (typeof address !== 'string') return false
      try {
        return await probe(normalizeHubAddress(address))
      } catch {
        // An address still half typed: this is not an error to display, the
        // refusal will come at validation time, with its reason.
        return false
      }
    })

    ipcMain.handle('hub:valider', (_event, address: unknown) => {
      try {
        const origin = normalizeHubAddress(typeof address === 'string' ? address : '')
        finish(origin)
        browserWindow.close()
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    })

    // Closing without validating: `finish` has already decided if we have just
    // validated, so the order of the two events does not have to be guessed.
    browserWindow.on('closed', () => finish(null))

    void browserWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(renderHubAddressPage({ initialValue: options.initialValue }))}`,
    )
  })
}

/**
 * Reachability, not availability.
 *
 * `probeConnectivity` answers `OFFLINE` when nothing picks up and `DEGRADED` when
 * the hub answers over HTTP with no real time — here, both non-`OFFLINE` answers
 * mean "there is indeed a hub at this address": the WebSocket channel is judged
 * once paired, not before.
 */
async function probeHub(origin: string): Promise<boolean> {
  return (await probeConnectivity({ hubOrigin: origin, timeoutMs: 2_000 })) !== 'OFFLINE'
}
