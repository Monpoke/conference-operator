; The default installation folder: `%LOCALAPPDATA%\Programs\room-control`.
;
; electron-builder only takes `productName` for the folder when it is plain
; ASCII. `Régie de salle` has an accent, so it fell back on the npm name, minus
; its slash: `@conference-operatorroom-client`. Renaming the package is not the
; way out — Electron derives `userData` from that name, and a room would come up
; unpaired. The folder is a filename, so it follows `artifactName` and the Linux
; `executableName`.
;
; Laid down as the previous installation's path, which `initMultiUser` reads
; just after this macro — and only when there is none: an update keeps the
; folder it was installed in, rather than leaving a second copy behind.
!macro preInit
  !ifndef BUILD_UNINSTALLER
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    StrCmp $0 "" 0 +2
      WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\room-control"
  !endif
!macroend
