# Sidepad

태블릿이나 다른 기기의 브라우저를 Windows의 두 번째 모니터로 사용하세요. 같은 공유기에 연결하면 PC에서 창을 옮겨 두 화면에 서로 다른 작업을 띄울 수 있습니다.

**[Windows용 Sidepad 다운로드 (.exe, 약 122 MB)](https://github.com/yjjyjjyjjyjj/sidepad/releases/download/v0.2.0/Sidepad-Setup-0.2.0-x64.exe)**

v0.2.0 사전 출시판 · Windows 10/11 · Intel/AMD 64비트(x64) · [모든 릴리스](https://github.com/yjjyjjyjjyjj/sidepad/releases)

## 설치하고 연결하기

1. Windows PC에서 설치 파일을 실행하고 관리자 확인을 허용하세요. 설치 프로그램이 가상 드라이버를 준비하고 **1920 × 1080 / 60 Hz** 확장 화면을 설정합니다. 재시작 안내가 나오면 Windows를 재시작한 뒤 Sidepad를 여세요.
2. PC와 기기를 같은 개인 네트워크에 연결하세요. PC는 공유기에 유선으로 연결해도 됩니다.
3. 기기로 Sidepad 창의 **QR 코드**를 스캔하고 브라우저에서 **연결하기**를 누르세요.
4. PC의 **보낼 화면**에서 가상 디스플레이를 선택하고 **화면 전송 시작**을 누르세요. PC의 키보드와 마우스로 창을 해당 화면으로 옮기면 기기에 표시됩니다.

설치 EXE에는 아직 배포자 코드서명이 없어 Windows에 게시자 확인 경고가 표시될 수 있습니다. [설치·제거 안내](docs/INSTALL.ko.txt)

## 연결이 안 될 때

- **QR로 페이지가 열리지 않으면** PC 앱에서 Wi-Fi 또는 유선 LAN 주소를 선택하고 새 QR을 스캔하세요. 게스트 Wi-Fi에서는 기기 간 연결이 차단될 수 있습니다.
- **보낼 화면이 없으면** Sidepad에서 **새 가상 모니터 추가 → 드라이버 설치 및 설정**을 누르고, Windows 디스플레이 설정에서 가상 모니터가 **확장** 상태인지 확인하세요.

[개발 인수인계](docs/HANDOFF.ko.md) · [개발·빌드·배포](docs/DEVELOPMENT.md) · [성능 측정 및 검증 기록](docs/VALIDATION.md) · [서드파티 라이선스](THIRD_PARTY_NOTICES.md)
