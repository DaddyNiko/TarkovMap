; ⚠️ TARKOVMAP'S PORTABLE LAUNCHER STUB — replaces electron-builder's portable.nsi
; (scripts/patch-portable-nsi.mjs copies it over the template before every
; build; electron-builder offers no hook for the portable script).
;
; WHY (2026-09-02). The stock template recursively deletes its unpack folder
; before it extracts and again after the app exits, and `unpackDirName` pins
; that folder to one fixed path. So starting TarkovMap.exe a SECOND time while TarkovMap
; is already running deleted every unlocked file under the running instance —
; resources\app.asar.unpacked (the bundled ffmpeg and the Whisper bindings),
; the locales, the GPU dlls — then extracted, ran a second app that hit the
; single-instance lock and quit, and deleted the folder again. The first
; instance kept running with no ffmpeg: every caption request failed with
; "ffmpeg isn't available" and dictation went dead, and nothing on screen
; connected that to the double-click.
;
; THE GUARD: if the app exe in $INSTDIR cannot be opened for writing, an
; instance is running. Hand it the click (Electron's second-instance handler
; shows the window) and leave its files alone.

!include "common.nsh"
!include "extractAppPackage.nsh"

# https://github.com/electron-userland/electron-builder/issues/3972#issuecomment-505171582
CRCCheck off
WindowIcon Off
AutoCloseWindow True
RequestExecutionLevel ${REQUEST_EXECUTION_LEVEL}

Function .onInit
  !ifndef SPLASH_IMAGE
    SetSilent silent
  !endif

  !insertmacro check64BitAndSetRegView
FunctionEnd

Function .onGUIInit
  InitPluginsDir

  !ifdef SPLASH_IMAGE
    File /oname=$PLUGINSDIR\splash.bmp "${SPLASH_IMAGE}"
    BgImage::SetBg $PLUGINSDIR\splash.bmp
    BgImage::Redraw
  !endif
FunctionEnd

Section
  !ifdef SPLASH_IMAGE
    HideWindow
  !endif

  StrCpy $INSTDIR "$PLUGINSDIR\app"
  !ifdef UNPACK_DIR_NAME
    StrCpy $INSTDIR "$TEMP\${UNPACK_DIR_NAME}"
  !endif

  ; ── TarkovMap: is an instance already running out of $INSTDIR? ──────────────
  ; A running exe refuses a write handle; a leftover from a previous run does
  ; not. Only a refusal means "running" — a missing file falls through to the
  ; ordinary fresh extraction below.
  ${StdUtils.GetAllParameters} $R0 0
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 goodh_fresh
    ClearErrors
    FileOpen $1 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" a
    IfErrors goodh_running
    FileClose $1
    Goto goodh_fresh
  goodh_running:
    ; The running app owns this folder. Pass the click along and get out —
    ; nothing here may delete or overwrite a file it is using.
    Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" $R0'
    SetErrorLevel 0
    Quit
  goodh_fresh:

  RMDir /r $INSTDIR
  SetOutPath $INSTDIR

  !ifdef APP_DIR_64
    !ifdef APP_DIR_ARM64
      !ifdef APP_DIR_32
        ${if} ${IsNativeARM64}
          File /r "${APP_DIR_ARM64}\*.*"
        ${elseif} ${RunningX64}
          File /r "${APP_DIR_64}\*.*"
        ${else}
          File /r "${APP_DIR_32}\*.*"
        ${endIf}
      !else
        ${if} ${IsNativeARM64}
          File /r "${APP_DIR_ARM64}\*.*"
        ${else}
          File /r "${APP_DIR_64}\*.*"
        {endIf}
      !endif
    !else
      !ifdef APP_DIR_32
        ${if} ${RunningX64}
          File /r "${APP_DIR_64}\*.*"
        ${else}
          File /r "${APP_DIR_32}\*.*"
        ${endIf}
      !else
        File /r "${APP_DIR_64}\*.*"
      !endif
    !endif
  !else
    !ifdef APP_DIR_32
      File /r "${APP_DIR_32}\*.*"
    !else
      !insertmacro extractEmbeddedAppPackage
    !endif
  !endif

  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_FILE", "$EXEPATH").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_APP_FILENAME", "${APP_FILENAME}").r0'

  !ifdef SPLASH_IMAGE
    BgImage::Destroy
  !endif

	ExecWait "$INSTDIR\${APP_EXECUTABLE_FILENAME} $R0" $0
  SetErrorLevel $0

  SetOutPath $EXEDIR
	RMDir /r $INSTDIR
SectionEnd
