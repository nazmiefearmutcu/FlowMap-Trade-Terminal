# FlowMap 1.6.1

FlowMap 1.6.1 fixes one fault of the Windows setup program in 1.6.0. Nothing else in the app changed. The full list is in the [changelog](../CHANGELOG.md), and the 1.6.0 changes are in the [1.6.0 release notes](release-notes-1.6.0.md).

## What changed

- **Windows upgrade leaves no old runtime behind.** When the 1.6.0 setup program (`FlowMap_1.6.0_x64-setup.exe` or the `arm64` one) was run over an older install, it copied the new Python runtime over the old one and did not delete the old files. The program folder then held two versions of some packages, for example `flowmap_server` 1.5.1 next to 1.6.0. The app started the 1.6.0 server, but the leftover files took disk space and could make the installed version unclear. The 1.6.1 setup program closes a running FlowMap, removes the old `pyruntime` folder and then copies the new one.

## Who should update

- **Windows, installed with the setup program, upgraded from 1.5.1 or older to 1.6.0:** install 1.6.1. It also removes the leftovers that the 1.6.0 upgrade left.
- **Windows, fresh 1.6.0 install or MSI install:** not affected. 1.6.1 is the same app.
- **macOS and Linux:** not affected. 1.6.1 is the same app.

Recordings, logs and settings are kept. They are in the app-data folder (`%APPDATA%\com.nazmiefearmutcu.flowmap`), which the installer does not touch.

## Known limits

The known limits of 1.6.0 still apply, including the unsigned installers. See the [1.6.0 release notes](release-notes-1.6.0.md#known-limits).
