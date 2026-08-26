import { contextBridge, ipcRenderer } from 'electron'

/**
 * Pont de l'écran d'adresse du hub.
 *
 * Le seul préchargement de l'application, et il ne sert qu'à cette fenêtre :
 * elle s'ouvre avant le serveur d'affichage local, elle n'a donc aucun `/control`
 * à qui parler — contrairement à la régie et à la projection, qui passent par
 * HTTP et n'ont besoin de rien d'Electron.
 */
contextBridge.exposeInMainWorld('hub', {
  tester: (adresse: string): Promise<boolean> => ipcRenderer.invoke('hub:tester', adresse),
  valider: (adresse: string): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('hub:valider', adresse),
})
