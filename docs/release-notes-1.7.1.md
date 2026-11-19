# FlowMap 1.7.1

FlowMap 1.7.1 hardens WebGL rendering and GPU context recovery, tightens the Python server and desktop shell, fixes frontend state and accessibility issues, and refines theme contrast and narrow-window layout. The full list is in the [changelog](../CHANGELOG.md).

## What changed

- **WebGL rendering and context recovery.** After a GPU context loss and restore, the heatmap ring is rebuilt from CPU history rather than staying blank until new columns arrive. Shader range guards prevent division-by-zero artifacts, mipmap and column caches clear cleanly across symbol and DPR changes, and PNG exports preserve overlays and crisp scaling.
- **Overlays, indicators and crosshair.** Price-axis labels, BBO markers, GEX levels, VWAP and profile badges avoid colliding on dense charts. Indicator overlays and drawings align cleanly to device pixels across resizes, and crosshair price/time pills and the heat legend stay readable against every theme.
- **Frontend state, transport and accessibility.** WebSocket reconnection, history fetches, sidecar startup waits and quote feeds discard stale responses across rapid market switches. Clicking the Research toggle no longer corrupts the active drawer tab. Keyboard shortcuts, dialog focus management, ARIA roles and labels, alert audio/monitoring and the replay picker were hardened across panels.
- **Institutional UI polish and narrow windows.** Theme color tokens, tabular figures, dividers and focus indicators were refined across the built-in themes and Pixel style. Top-bar controls and the desk toolbar FPS readout no longer wrap or clip on narrower windows in English or Turkish.
- **Server hardening and Polars 2.0 compatibility.** Market feeds, session book and history slicing, overview pyramids, recording rotation, export endpoints and WebSocket teardown close lifecycle leaks, validate bounds more strictly and clear Polars 2.0 deprecation warnings.
- **Desktop shell hardening.** The Tauri shell checks Windows TCP table buffer bounds and requires loopback-only listener ownership, redacts `flowmap.auth.<token>` WebSocket subprotocol headers with independent per-pipe log buffers, backs off after failed log rotations, writes an unlocked sibling PID file so a second Windows instance can focus the running window, and writes configuration files via unique fsynced temporary files.

## Known limits

The known limits of 1.7.0 and 1.6.0 still apply, including the unsigned installers. See the [1.7.0 release notes](release-notes-1.7.0.md#known-limits) and the [1.6.0 release notes](release-notes-1.6.0.md#known-limits).
