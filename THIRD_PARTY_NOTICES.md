# Third-party notices

## Virtual Display Driver

Sidepad can install and configure [Virtual Display Driver](https://github.com/VirtualDrivers/Virtual-Display-Driver), maintained by VirtualDrivers. The Windows installer includes the unmodified signed x64 driver INF, DLL, catalog and settings XML, together with its license. Driver binaries are downloaded during the build and are not committed to this repository.

The automated download is pinned to **25.7.23** and checked against SHA-256 `A701F2272E9FCF382849B24F913C6DD07597B3B1116525F2E90182F019609154` from Microsoft's WinGet manifest. That release's project source is under the **MIT License**, copyright (c) 2024 Virtual Display. It permits use, modification, distribution and commercial use subject to retaining the copyright and permission notice. The unmodified notice is in [licenses/Virtual-Display-Driver.txt](licenses/Virtual-Display-Driver.txt), copied from the [release license](https://github.com/VirtualDrivers/Virtual-Display-Driver/blob/25.7.23/LICENSE).

Sidepad does not bundle DevCon or Virtual Driver Control. Its own registration helper calls the Windows SetupAPI and newdev system libraries. No certificate-store changes, test signing or driver-policy bypass is performed. Sidepad's icon is an original vector asset in `src/assets/sidepad.svg`.

Electron, ws and qrcode retain the licenses supplied with their packages. Electron's `LICENSE.electron.txt` and `LICENSES.chromium.html` are included in the installation directory; dependency notices are retained in `resources/app.asar/node_modules`.
