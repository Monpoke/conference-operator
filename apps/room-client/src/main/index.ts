import { join } from 'node:path'
import { app, BrowserWindow, safeStorage, screen } from 'electron'
import { RoomApp } from '../core/room-app.js'
import { formaterLigneJournal } from '../core/journal-console.js'
import { createMockObsTransport } from '../core/obs-mock.js'
import { decalageDuMode, lireMode } from '../core/mode.js'
import { loadOrCreateClientId } from './identity.js'
import { createSecretVault } from './secrets.js'
import { resoudreAdresseHub } from './adresse-hub.js'
import { demanderAdresseHub } from './fenetre-hub.js'

/**
 * Coquille Electron : volontairement mince.
 *
 * Toute la logique vit dans `core/`, sans dépendance à Electron, pour être
 * testable sans écran ni instance OBS. Ce fichier ne fait qu'ouvrir les fenêtres
 * et brancher les chemins de données.
 */

/**
 * Mode d'exécution, lu une fois au démarrage.
 *
 * `MODE=dev` déroule un talk complet sans installer OBS ; hors de ce mode, les
 * commodités de développement sont neutralisées même si elles traînent dans
 * l'environnement — un `OBS_MOCK=1` oublié, c'est une journée filmée par une
 * instance OBS qui n'existe pas.
 */
const MODE = lireMode()

async function main(): Promise<void> {
  await app.whenReady()

  /**
   * Verrou de fermeture, posé avant la première fenêtre.
   *
   * Entre l'écran d'adresse — refermé dès la saisie validée — et l'ouverture
   * de la projection, l'application ne possède aucune fenêtre. Electron émet
   * alors `window-all-closed`, dont le comportement par défaut est de quitter :
   * sans ce verrou, la salle s'éteindrait entre deux fenêtres.
   */
  let demarrageTermine = false
  app.on('window-all-closed', () => {
    if (demarrageTermine) app.quit()
  })

  const dataDir = app.getPath('userData')
  const clientId = loadOrCreateClientId(join(dataDir, 'client-id'))

  // Avant tout le reste : sans hub, il n'y a ni salle à choisir, ni programme
  // à projeter. Demandé une fois par machine, puis mémorisé.
  const hubOrigin = await resoudreAdresseHub({
    chemin: join(dataDir, 'hub'),
    demander: (valeurInitiale) => demanderAdresseHub({ valeurInitiale }),
    onLog: (niveau, message) => console.error(formaterLigneJournal(niveau, message)),
  })
  if (hubOrigin == null) {
    console.error(formaterLigneJournal('error', "Aucune adresse de hub : l'application s'arrête"))
    app.quit()
    return
  }

  const vault = createSecretVault(join(dataDir, 'jeton'), safeStorage, (message) =>
    console.warn(message),
  )

  for (const { variable, raison } of MODE.ignores) {
    console.error(formaterLigneJournal('error', `${variable} ignoré : ${raison}`))
  }
  if (MODE.mode === 'dev') {
    console.warn(formaterLigneJournal('warn', 'MODE DÉVELOPPEMENT — à ne pas laisser le jour J'))
  }

  const room = new RoomApp({
    dataDir,
    mode: MODE.mode,
    hubOrigin,
    clientId,
    roomId: process.env.ROOM_ID,
    regieViteOrigin: process.env.REGIE_VITE_ORIGIN ?? null,
    obsTransportFactory: MODE.obsSimule
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

  // Heure simulée locale, s'il y en a une : posée comme décalage, exactement
  // comme le fera le hub dès qu'il répondra — et il reprendra la main.
  const decalage = decalageDuMode(MODE)
  if (decalage !== 0) room.runtime.setClockOffset(decalage, true)

  // L'écran d'abord : la salle doit projeter même si le hub ne répond jamais.
  const displayUrl = await room.startDisplay()
  brancherOuverturesDEcrans(openRegieWindow(`${displayUrl}/regie`))
  // La régie est ouverte : fermer la dernière fenêtre veut de nouveau dire
  // « on éteint ».
  demarrageTermine = true

  // Le hub peut être lancé après les salles : on le rejoindra tout seul.
  room.startSupervision()

  const token = await room.ensurePaired()
  if (token != null) {
    await room.connectHub(token)
    await room.connectObs()
  }

  app.on('before-quit', () => {
    // Sans fermeture explicite, les timers de reconnexion gardent le process
    // en vie et l'application ne se ferme jamais.
    void room.close()
  })
}

/**
 * Fenêtre de régie, sur l'écran de l'opérateur.
 *
 * La seule ouverte au démarrage, et avant tout appel réseau : l'opérateur doit
 * avoir la main sur OBS et sur l'écran même si le hub ne répond jamais. Les
 * autres écrans s'ouvrent à la demande, depuis son menu « Écrans ».
 */
function openRegieWindow(url: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    // Montrée seulement une fois peinte : maximiser une fenêtre déjà visible
    // la fait sauter d'un format à l'autre sous les yeux de l'opérateur.
    show: false,
    backgroundColor: '#0d0f16',
    autoHideMenuBar: true,
    /**
     * Titre d'amorçage seulement.
     *
     * La page le remplace par « Régie — <événement> » dès le premier rendu,
     * avec le nom que le hub a tranché. L'écrire ici serait le figer dans le
     * binaire installé sur la machine — c'est-à-dire pour toutes les éditions
     * qu'elle servira ensuite.
     */
    title: 'Régie de salle',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  /**
   * Maximisée d'emblée.
   *
   * La page est composée pour que **rien qui commande ne défile** : tout ce qui
   * déclenche une décision tient dans la hauteur de fenêtre. Ouverte à 860 px
   * sur un moniteur d'opérateur, cette promesse se paie en boutons resserrés,
   * pour de la place laissée vide autour. Les dimensions ci-dessus restent le
   * format restauré, après un clic sur « réduire ».
   */
  brancherPleinEcran(window)
  window.once('ready-to-show', () => {
    // Maximisée avant d'être montrée, mais **une fois peinte** : sur une
    // fenêtre encore masquée, la demande part à un gestionnaire de fenêtres qui
    // ne connaît pas encore la fenêtre, et retombe en silence — la régie
    // s'ouvrait alors à ses dimensions de repli.
    window.maximize()
    window.show()
  })
  void window.loadURL(url)
  return window
}

/**
 * Écrans ouverts depuis le menu « Écrans » de la régie.
 *
 * La projection n'est plus ouverte au démarrage — une fenêtre de plus sur
 * l'écran de l'opérateur, pour un secours qui ne sert presque jamais. Mais
 * quand elle sert, elle sert vite : ouverte depuis le menu, elle doit retrouver
 * exactement le placement qu'elle avait au lancement — plein écran sur la
 * sortie vidéoprojecteur — au lieu de la fenêtre par défaut que produirait un
 * simple `target="_blank"`, posée au milieu de l'écran de régie.
 *
 * Les autres écrans du menu — habillages, bandeau live, mur public — s'ouvrent
 * normalement : ils vont dans OBS ou sur un téléphone, pas sur un projecteur.
 */
function brancherOuverturesDEcrans(regie: BrowserWindow): void {
  regie.webContents.setWindowOpenHandler(({ url }) => {
    if (cheminDe(url) !== '/display/projector') return { action: 'allow' }
    openProjectorWindow(url)
    return { action: 'deny' }
  })
}

function cheminDe(url: string): string | null {
  try {
    return new URL(url).pathname
  } catch {
    return null
  }
}

/**
 * Bascule plein écran au clavier : **Alt+Entrée**, et F11.
 *
 * Posée dans le processus principal, pas dans la page : les écrans sont servis
 * en HTTP par le serveur local, sans préchargement, et n'ont donc aucun moyen
 * d'appeler Electron. `before-input-event` voit la frappe avant la page, ce qui
 * rend le raccourci indépendant de ce qui a le focus — un champ de saisie
 * ouvert ne doit pas l'avaler.
 *
 * Alt+Entrée est libre : la régie laisse déjà passer toute touche tenue avec
 * Alt, qui appartient au navigateur. Échap n'est pas repris, lui : la page s'en
 * sert pour refermer ses modales, et le lui prendre ferait sortir du plein
 * écran au lieu de fermer celle qu'on regarde.
 */
function brancherPleinEcran(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (evenement, saisie) => {
    if (saisie.type !== 'keyDown') return
    if (saisie.key !== 'F11' && !(saisie.key === 'Enter' && saisie.alt)) return
    evenement.preventDefault()
    window.setFullScreen(!window.isFullScreen())
  })
}

/**
 * Fenêtre de projection, sur l'écran secondaire quand il existe.
 *
 * Sert de secours : si OBS-A plante, l'opérateur bascule dessus et la
 * projection continue sans rien reconfigurer. Ouverte à la demande depuis le
 * menu « Écrans » de la régie.
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
  // Sur un poste à un seul écran, elle s'ouvre en fenêtre : le plein écran au
  // clavier est alors ce qui rend le secours utilisable devant une salle.
  brancherPleinEcran(window)
  void window.loadURL(url)
  return window
}

void main()
