; 自定义 NSIS 片段：安装目录固定成 multi-cmd，不跟着 exe 文件名（electron.exe）跑。
;
; 背景：为了通过 Windows 智能应用控制，exe 必须保持官方 electron.exe 原样不动，
; 于是 build.win.executableName = "electron"；但 electron-builder 会用这个名字去算
; 安装目录（%LOCALAPPDATA%\Programs\electron）和快捷方式参数，观感很差。
; 这里把目录和快捷方式显式改回来。

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
  StrCpy $installMode "CurrentUser"
!macroend

!macro customInit
  ; 用户没显式改过安装目录时，用 multi-cmd 而不是 electron
  ${if} $INSTDIR == ""
  ${orIf} $INSTDIR == "$LOCALAPPDATA\Programs\electron"
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\multi-cmd"
  ${endIf}
!macroend

!macro customInstall
  ; 覆盖掉指向 electron.exe 的快捷方式，改成 multi-cmd 这个名字
  Delete "$DESKTOP\multi-cmd.lnk"
  CreateShortCut "$DESKTOP\multi-cmd.lnk" "$INSTDIR\electron.exe" "" "$INSTDIR\electron.exe" 0
  Delete "$SMPROGRAMS\multi-cmd.lnk"
  CreateShortCut "$SMPROGRAMS\multi-cmd.lnk" "$INSTDIR\electron.exe" "" "$INSTDIR\electron.exe" 0

  ; 卸载器文件名跟着 exe 名字变成了 "Uninstall electron.exe"，装进 Programs 里很难看，
  ; 这里顺手改回 multi-cmd
  IfFileExists "$INSTDIR\Uninstall electron.exe" 0 +2
    Rename "$INSTDIR\Uninstall electron.exe" "$INSTDIR\Uninstall multi-cmd.exe"
!macroend

!macro customUnInstall
  Delete "$DESKTOP\multi-cmd.lnk"
  Delete "$SMPROGRAMS\multi-cmd.lnk"
!macroend
