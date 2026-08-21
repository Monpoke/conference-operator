import { join } from 'node:path'
import { app, BrowserWindow, safeStorage, screen } from 'electron'
import { RoomApp } from '../core/room-app.js'
import { formaterLigneJournal } from '../core/journal-console.js'
import { createMockObsTransport } from '../core/obs-mock.js'
import { loadOrCreateClientId } from './identity.js'
import { createSecretVault } from './secrets.js'

/**
 * Coquille Electron : volontairement mince.
 *
 * Toute la logique vit dans `core/`, sans dépendance à Electron, pour être
 * testable sans écran ni instance OBS. Ce fichier ne fait qu'ouvrir les fenêtres
 * et brancher les chemins de données.
 */

const HUB_ORIGIN = process.env.HUB_ORIGIN ?? 'http://localhost:8787'
/** `OBS_MOCK=1` : dérouler un talk complet sans installer OBS. */
const OBS_SIMULE = process.env.OBS_MOCK === '1'

async function main(): Promise<void> {
  await app.whenReady()

  const dataDir = app.getPath('userData')
  const clientId = loadOrCreateClientId(join(dataDir, 'client-id'))
  const vault = createSecretVault(join(dataDir, 'jeton'), safeStorage, (message) =>
    console.warn(message),
  )

  const room = new RoomApp({
    dataDir,
    hubOrigin: HUB_ORIGIN,
    clientId,
    roomId: process.env.ROOM_ID,
    obsTransportFactory: OBS_SIMULE
      ? (instance) =>
          createMockObsTransport({
            instance,
            recordingDir: join(dataDir, 'enregistrements'),
            onLog: (message) => console.log(message),
          })
      : undefined,
    readToken: () => vault.read(),
    writeToken: (token) => vault.write(token),
    onLog: (level, message, context) =>
      console[level === 'error' ? 'error' : 'log'](formaterLigneJournal(level, message, context)),
    onPairingCode: (code) => {
      console.log(`Code d'appairage : ${code.user_code} — à approuver dans l'admin du hub`)
    },
  })

  // L'écran d'abord : la salle doit projeter même si le hub ne répond jamais.
  const displayUrl = await room.startDisplay()
  openProjectorWindow(`${displayUrl}/display/projector`)
  openRegieWindow(`${displayUrl}/regie`)

  // Le hub peut être lancé après les salles : on le rejoindra tout seul.
  room.startSupervision()

  const token = await room.ensurePaired()
  if (token != null) {
    await room.connectHub(token)
    await room.connectObs()
  }

  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => {
    // Sans fermeture explicite, les timers de reconnexion gardent le process
    // en vie et l'application ne se ferme jamais.
    void room.close()
  })
}

/**
 * Fenêtre de projection, ouverte sur l'écran secondaire quand il existe.
 *
 * Sert de secours : si OBS-A plante, l'opérateur bascule dessus et la
 * projection continue sans rien reconfigurer.
 */
/**
 * Fenêtre de régie, sur l'écran de l'opérateur.
 *
 * Ouverte juste après la projection et avant tout appel réseau : l'opérateur
 * doit avoir la main sur OBS et sur l'écran même si le hub ne répond jamais.
 */
function openRegieWindow(url: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#0d0f16',
    autoHideMenuBar: true,
    title: 'Régie — Cloud Nord',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  void window.loadURL(url)
  return window
}

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
  void window.loadURL(url)
  return window
}

void main()
