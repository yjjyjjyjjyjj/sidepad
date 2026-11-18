# Third-party notices

## Virtual Display Driver

Sidepad can install and configure [Virtual Display Driver](https://github.com/VirtualDrivers/Virtual-Display-Driver), maintained by VirtualDrivers. Driver binaries are downloaded separately through WinGet and are not included in this repository.

The automated download is pinned to **25.7.23**. That release's project source is under the **MIT License**, copyright (c) 2024 Virtual Display. It permits use, modification, distribution and commercial use subject to retaining the copyright and permission notice. The unmodified notice is in [licenses/Virtual-Display-Driver.txt](licenses/Virtual-Display-Driver.txt), copied from the [release license](https://github.com/VirtualDrivers/Virtual-Display-Driver/blob/25.7.23/LICENSE).

This notice does not relicense separate utilities or dependencies in the upstream download, including Microsoft's device installer. Sidepad uses the upstream signed package; any future bundled installer must retain applicable notices for the binaries it actually redistributes. Sidepad's icon is an original vector asset in `src/assets/sidepad.svg`.

Electron, ws and qrcode retain the licenses supplied with their packages.
