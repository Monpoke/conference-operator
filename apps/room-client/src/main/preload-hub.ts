import { contextBridge, ipcRenderer } from 'electron'

/**
 * The bridge of the hub-address screen.
 *
 * The application's only preload, and it serves that window alone: it opens
 * before the local display server, so it has no `/control` to talk to — unlike
 * the control app and the projection, which go through HTTP and need nothing
 * from Electron.
 *
 * The channel names `hub:tester` and `hub:valider` are a frozen contract between
 * the main process and this bridge: they do not get renamed.
 */
contextBridge.exposeInMainWorld('hub', {
  test: (address: string): Promise<boolean> => ipcRenderer.invoke('hub:tester', address),
  validate: (address: string): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('hub:valider', address),
})
