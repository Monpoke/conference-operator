import { join } from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import { renderAdresseHubPage } from '../core/adresse-hub-page.js'
import { probeConnectivity } from '../core/connectivity.js'
import { normaliserAdresseHub } from './adresse-hub.js'

export interface FenetreHubOptions {
  valeurInitiale: string
  /** Injectable pour les tests ; sonde `/health` par défaut. */
  tester?: (origine: string) => Promise<boolean>
}

/**
 * Demande l'adresse du hub et rend l'origine validée.
 *
 * `null` quand l'opérateur ferme la fenêtre sans valider : il n'y a alors pas
 * de salle à démarrer, et l'appelant quitte.
 */
export function demanderAdresseHub(options: FenetreHubOptions): Promise<string | null> {
  const tester = options.tester ?? sonderHub

  const fenetre = new BrowserWindow({
    width: 620,
    height: 480,
    resizable: false,
    backgroundColor: '#0b0d14',
    autoHideMenuBar: true,
    title: 'Régie de salle',
    webPreferences: {
      // Chemin depuis le bundle : `dist/main.cjs` et `dist/preload-hub.cjs`
      // sont voisins, dans le paquet comme en développement.
      preload: join(__dirname, 'preload-hub.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  return new Promise<string | null>((resolve) => {
    let rendu = false

    const terminer = (valeur: string | null) => {
      if (rendu) return
      rendu = true
      ipcMain.removeHandler('hub:tester')
      ipcMain.removeHandler('hub:valider')
      resolve(valeur)
    }

    ipcMain.handle('hub:tester', async (_evenement, adresse: unknown) => {
      if (typeof adresse !== 'string') return false
      try {
        return await tester(normaliserAdresseHub(adresse))
      } catch {
        // Adresse encore à moitié tapée : ce n'est pas une erreur à afficher,
        // le refus viendra à la validation, avec sa raison.
        return false
      }
    })

    ipcMain.handle('hub:valider', (_evenement, adresse: unknown) => {
      try {
        const origine = normaliserAdresseHub(typeof adresse === 'string' ? adresse : '')
        terminer(origine)
        fenetre.close()
        return { ok: true }
      } catch (erreur) {
        return { ok: false, message: erreur instanceof Error ? erreur.message : String(erreur) }
      }
    })

    // Fermeture sans validation : `terminer` a déjà tranché si l'on vient de
    // valider, l'ordre des deux événements n'a donc pas à être deviné.
    fenetre.on('closed', () => terminer(null))

    void fenetre.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(renderAdresseHubPage({ valeurInitiale: options.valeurInitiale }))}`,
    )
  })
}

/**
 * Joignabilité, pas disponibilité.
 *
 * `probeConnectivity` répond `OFFLINE` quand rien ne décroche et `DEGRADED`
 * quand le hub répond en HTTP sans temps réel — ici, les deux réponses non
 * `OFFLINE` valent « c'est bien un hub, à cette adresse » : le canal WebSocket
 * se juge une fois appairé, pas avant.
 */
async function sonderHub(origine: string): Promise<boolean> {
  return (await probeConnectivity({ hubOrigin: origine, timeoutMs: 2_000 })) !== 'OFFLINE'
}
