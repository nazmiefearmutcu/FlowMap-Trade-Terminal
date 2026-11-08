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
