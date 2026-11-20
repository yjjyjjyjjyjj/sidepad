# Sidepad 개발 인수인계

2026-11-21 기준, 이어서 유지보수할 버전은 **0.2.0**이다. Sidepad는 Windows의 보조 디스플레이를 같은 LAN의 기기 브라우저에 띄운다.
사용자가 원하는 동작은 창을 옮길 수 있는 **확장 화면**이다. 수신 기기에 앱을 설치하거나 별도 장비를 연결할 필요가 없다.

## 기준 버전과 결정 사항

- 사용자가 복원한 소스 기준점은 [`75d4335`](https://github.com/yjjyjjyjjyjj/sidepad/commit/75d4335b5055ecd54be60f79d8a9a5dc07909f77)이다.
  공개 설치 EXE를 재현할 때는 [`v0.2.0` 태그](https://github.com/yjjyjjyjjyjj/sidepad/tree/v0.2.0)의 커밋 `1684fce`를 사용한다.
  태그 이후의 변경은 배포 워크플로와 문서에 한정됐다.
- 게임 중 PC 부하를 줄이려고 **Sidepad Direct** 가상 드라이버에서 NVIDIA 인코더로 화면을 직접 넘기는 방식을 시험했다.
  사용자는 이 실험을 종료하고 공개 EXE를 다시 설치했다. 실험 소스·빌드 산출물과 개발 PC의 Direct 장치·드라이버 패키지는 삭제했다.
  현재 유지보수 대상은 MttVDD와 Electron 송신 경로다.
- 기기 터치로 Windows를 조작하는 기능은 향후 아이디어다. 현재 입력은 PC의 키보드와 마우스로 처리한다.
  UI에서는 수신 대상을 ‘기기’로 표기한다.

## 화면이 전달되는 경로

1. **Windows가 보조 화면을 만든다.** 설치 프로그램은 기존 `Root\MttVDD` 장치를 확인하고, 필요하면 번들 드라이버를 등록한다.
   사용자 세션에서 1920 × 1080, 60 Hz 확장 화면을 설정하고 기존 물리 화면의 배치를 확인한다.
   [설치 흐름](../scripts/driver-setup.ps1) · [디스플레이 설정](../scripts/configure-virtual-display.ps1)
2. **Electron이 선택한 화면을 캡처한다.** 메인 프로세스가 캡처할 디스플레이를 연결하고 호스트 창이 `getDisplayMedia()`로 영상 트랙을 얻는다.
   저지연 모드도 선택한 해상도와 목표 프레임을 유지한다. 하드웨어 우선 설정에서 실제로 쓰이는 코덱과 인코더는 기기와의 협상 결과에 따라 달라진다.
   [메인 프로세스](../src/main.cjs) · [호스트 송신](../src/host/host.js) · [코덱 우선순위](../src/shared/codecs.js)
3. **브라우저가 WebRTC 영상을 재생한다.** 기본 TCP 포트 `3210`에서 HTTP로 뷰어를 제공하고 WebSocket으로 연결을 협상한다.
  QR의 토큰으로 수신 기기 한 대를 인증한다. 영상은 별도의 WebRTC 연결로 흐르며 외부 STUN/TURN 서버는 설정하지 않는다. QR이나 토큰이 담긴 URL은 공개 로그에서 제외한다.
   [연결 서버](../src/server.cjs) · [브라우저 수신](../src/viewer/viewer.js)

## 실행과 검증

Windows 10/11 x64, Node.js 22.12 이상에서 저장소 루트를 기준으로 실행한다.

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
```

- 기본 앱은 `npm.cmd start`로 연다. 사용 중인 3210 연결을 유지하며 시험하려면 `npm.cmd run preview`를 사용한다.
  별도 프로필의 포트는 `preview` 3212, `preview:hardware` 3213, `preview:buffer` 3214다.
- `npm.cmd run smoke`는 실제 Windows 화면을 캡처해 같은 PC의 Chromium 뷰어까지 전송한다.
  `smoke`, `benchmark`, `probe:codecs`는 테스트 프로필을 공유하므로 하나씩 실행한다.
  실제 Wi-Fi를 확인할 때는 별도 기기로 QR을 열고 화면을 움직여 수신 프레임을 확인한다. [검증 명령과 실측 기록](VALIDATION.md)
- `npm.cmd run check`는 JavaScript 문법 검사다. 이 버전에는 `lint` 스크립트가 없다.
  작업 보고에는 실행한 테스트와 린트의 명령·종료 코드·통과 로그를 먼저 싣고, 미실행 항목은 이유를 적는다.
  실패 후 재시도했을 때도 이전 표준 출력·오류 원문을 보존한다. 길면 전체 로그를 로컬 파일로 제공하고 비밀값만 가린다.

## 성능 문제를 이어받을 때

게임 중 사용자가 겪은 문제는 **PC 게임의 FPS 하락과 순간 멈춤**이었다.
다시 비교할 때는 양쪽 모두 가상 화면에서 같은 영상을 재생하고, 기기에 실제 프레임이 도착하는지 확인한 뒤 같은 3DMark Steel Nomad 장면을 실행한다.
이전 Electron 측정 중 한 번은 가상 화면에서 영상을 재생하지 않아 조건이 달랐다. 마우스 체감만으로 전체 지연 차이를 확정할 수 없다.

iPad Air 5의 Chrome 실측에서는 NVIDIA HEVC, 1920 × 1080, 송신 약 57 fps를 확인했다.
해당 연결에서 수신 브라우저는 버퍼 제어 API를 제공하지 않았다. PC의 **지연·PC 사용량 진단**에서 실제 인코더 이름과 송수신 통계를 확인한다.
RTT는 네트워크 왕복 시간이고, 수신 처리 시간에는 버퍼·조립·디코딩이 포함된다. 전체 화면 지연과 게임 FPS는 별도로 측정해야 한다.
[실기기 측정 조건과 한계](VALIDATION.md) · [혼잡 시 전송량 조절](../src/shared/latency.js)

## 설치와 배포를 이어받을 때

- `npm.cmd run dist:win`은 Virtual Display Driver **25.7.23** 압축 파일의 SHA-256과 카탈로그 서명을 확인한 뒤 NSIS 설치 EXE를 `dist/`에 만든다.
  드라이버 라이선스와 고지를 함께 배포한다. 제거 프로그램은 설치 경로의 방화벽 규칙을 정리하고 공유 MttVDD 드라이버와 사용자 설정은 보존한다.
  [드라이버 준비](../scripts/prepare-driver.ps1) · [설치·제거 코드](../build/installer.nsh) · [라이선스 고지](../THIRD_PARTY_NOTICES.md)
- 공개 EXE 자체에는 게시자 서명이 없다. 한 PC에서 SmartScreen 실행 승인 후 첫 창이 뜨지 않았고, 공식 SHA-256과 일치하는 같은 파일을 다시 열자 설치 창이 떴다.
  대기 원인은 확인하지 못했다. 재현 시 EXE 해시, 설치 프로세스와 창, `%APPDATA%\Sidepad\setup-result.json`의 **수정 시각**을 함께 확인한다.
  [공개 사전 출시판과 체크섬](https://github.com/yjjyjjyjjyjj/sidepad/releases/tag/v0.2.0) · [사용자 설치 안내](INSTALL.ko.txt)
- 기존 드라이버가 있는 환경에서 설치·제거와 Full HD 전송을 검증했다. **드라이버가 전혀 없는 PC의 최초 등록**과 **재부팅 후 설정 재개**는 추가 실증 대상이다.
  설치 결과 코드 `3010`은 재부팅이 필요하다는 뜻이다. [설치 결과 처리](../scripts/install-driver.ps1) · [검증 이력](VALIDATION.md)
- 다음 버전을 배포할 때는 패키지 버전과 태그를 맞춘다. `v*` 태그 푸시 또는 기존 태그에 대한 수동 실행이 Windows 테스트·빌드와 릴리스 **초안** 생성을 시작한다.
  설치와 기기 연결을 확인한 뒤 초안을 게시하고 README 다운로드 링크를 갱신한다. [배포 워크플로](../.github/workflows/windows-release.yml) · [개발 안내](DEVELOPMENT.md)
