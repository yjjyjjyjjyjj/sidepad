!include WinVer.nsh

!macro customInit
  ${IfNot} ${IsNativeAMD64}
    MessageBox MB_OK|MB_ICONSTOP "이 설치 파일은 Intel/AMD 64비트 Windows용입니다. ARM 및 32비트 Windows는 지원하지 않습니다."
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "Sidepad는 Windows 10 또는 Windows 11이 필요합니다."
    Abort
  ${EndIf}
!macroend

!macro customInstallMode
  ; Keep app/profile ownership with the signed-in user; elevate only the helper.
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Sidepad 설치"
  !define MUI_WELCOMEPAGE_TEXT "같은 네트워크의 기기를 Windows 확장 모니터로 사용합니다.$\r$\n$\r$\nSidepad와 가상 디스플레이 드라이버를 설치하고 1920 × 1080 / 60 Hz 확장 화면으로 설정합니다.$\r$\n$\r$\n드라이버와 개인 네트워크 연결 설정에 Windows 관리자 확인이 필요합니다. 기존 물리 모니터의 배치는 유지합니다.$\r$\n$\r$\nWindows 10/11 Intel·AMD 64비트용입니다."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customInstall
  CreateDirectory "$APPDATA\Sidepad"
  setup_retry:
  DetailPrint "가상 드라이버 및 1920 × 1080 확장 화면 설정 중..."
  ${DisableX64FSRedirection}
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy RemoteSigned -File "$INSTDIR\resources\scripts\install-driver.ps1" -ResultPath "$APPDATA\Sidepad\setup-result.json" -DriverPath "$INSTDIR\resources\driver" -ExecutablePath "$INSTDIR\Sidepad.exe"'
  Pop $0
  ${EnableX64FSRedirection}
  ${If} $0 == 3010
    SetRebootFlag true
    DetailPrint "Windows 재시작이 필요합니다. 다음 Sidepad 실행 시 화면 설정을 자동으로 마칩니다."
    SetErrorLevel 3010
  ${ElseIf} $0 != 0
    ${If} ${Silent}
      SetErrorLevel 1
      Quit
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "가상 드라이버 또는 화면 설정을 완료하지 못했습니다.$\r$\n$\r$\n관리자 확인을 허용한 뒤 다시 시도해 주세요. 앱 파일은 설치되어 있으며, Sidepad의 ‘드라이버 설치 및 설정’에서 다시 시도할 수도 있습니다.$\r$\n$\r$\n결과: $APPDATA\Sidepad\setup-result.json" IDRETRY setup_retry
    SetErrorLevel 1
    Abort
  ${Else}
    DetailPrint "1920 × 1080 / 60 Hz 확장 화면 설정 완료"
  ${EndIf}
!macroend

!macro customUnInstall
  ; Preserve the shared virtual driver; remove only this executable's LAN rules.
  ${DisableX64FSRedirection}
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy RemoteSigned -File "$INSTDIR\resources\scripts\uninstall-network.ps1" -ExecutablePath "$INSTDIR\Sidepad.exe"'
  Pop $0
  ${EnableX64FSRedirection}
  ${If} $0 != 0
    DetailPrint "네트워크 규칙 정리를 완료하지 못했습니다. Sidepad 앱 제거는 계속합니다."
  ${EndIf}
!macroend
