; FlowMap NSIS installer hooks (referenced from tauri.windows.conf.json).
;
; The uninstaller removes the program files only. The per-user app data holds
; the recordings, logs and lock file, which can be large, so ask first. The
; default answer is No: recordings are kept unless the user asks for deletion.
; The prompt is bilingual because the installer language is chosen at runtime.
; A silent uninstall (/S, for example from a package manager) skips the prompt
; and keeps the data, so it never blocks on a dialog.
!macro NSIS_HOOK_POSTUNINSTALL
  IfSilent +3 +1
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "FlowMap kayıtlarını ve günlüklerini de silmek ister misiniz? Bu işlem geri alınamaz.$\r$\n$\r$\nDelete FlowMap recordings and logs too? This cannot be undone." IDNO +2
  RMDir /r "$APPDATA\com.nazmiefearmutcu.flowmap"
!macroend

; An upgrade installs over the previous version. NSIS only writes the files of
; the new version, so without this step the Python runtime of the old version
; stays next to the new one: two versions of a package side by side, and unused
; files that no uninstaller list names. Remove the old runtime before the copy.
;
; This hook runs before the installer's own running-app check, and a running app
; holds files of the runtime open, so make that check here first. The server
; process can outlive the window for a moment: retry for up to ten seconds. If
; a file is still held after that, the install continues over what is left.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  StrCpy $R9 0
  flowmap_runtime_retry:
  IfFileExists "$INSTDIR\pyruntime\*.*" 0 flowmap_runtime_done
  RMDir /r "$INSTDIR\pyruntime"
  IntOp $R9 $R9 + 1
  IntCmp $R9 20 flowmap_runtime_done
  Sleep 500
  Goto flowmap_runtime_retry
  flowmap_runtime_done:
!macroend
