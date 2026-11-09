# FlowMap documentation index

Start with the first two rows. Everything else is a record of an earlier decision or measurement, and
says so below.

| Document | Status | What it covers |
|---|---|---|
| [user-guide.md](user-guide.md) | Current | Using the app: install, first run, heatmap, replay, drawings, chart style, intelligence drawer, shortcuts |
| [architecture.md](architecture.md) | Current | Processes, HTTP routes, WebSocket and wire protocol, session token and origin policy |
| [development.md](development.md) | Current | Dev environment, tests, CI and release workflows, repository layout |
| [i18n-migration.md](i18n-migration.md) | Developer notes | Rules for UI strings, the English and Turkish tables, and number, price and time formatting |
| [release-notes-1.6.0.md](release-notes-1.6.0.md) | Current release | Release notes for 1.6.0 |
| [release-notes-1.5.1.md](release-notes-1.5.1.md) | Past release | Release notes for 1.5.1 |
| [release-notes-1.5.0.md](release-notes-1.5.0.md) | Past release | Release notes for 1.5.0 |
| [windows-minimum-benchmark.md](windows-minimum-benchmark.md) | Evidence | Benchmark notes and status for the Windows minimum-hardware claim (NOT QUALIFIED) |
| [history-overview-2026-10-08.md](history-overview-2026-10-08.md) | Design note | Recorded-depth overviews: how wide time views page aggregated columns (2026-10-08) |
| [superpowers/specs/2026-09-12-bookmap-visual-overhaul-design.md](superpowers/specs/2026-09-12-bookmap-visual-overhaul-design.md) | Approved design (2026-09-12) | Chart, heatmap and depth visual overhaul |
| [superpowers/specs/2026-09-03-replay-engine-design.md](superpowers/specs/2026-09-03-replay-engine-design.md) | Historical, partly superseded | Replay engine design. Wire depth tiles are now f32 (see architecture.md) |
| [superpowers/specs/2026-07-19-equity-two-sided-depth-design.md](superpowers/specs/2026-07-19-equity-two-sided-depth-design.md) | Historical, partly superseded | Equity two-sided depth design. Wire depth tiles are now f32 (see architecture.md) |
| [superpowers/specs/2026-07-18-flowmap-release-design.md](superpowers/specs/2026-07-18-flowmap-release-design.md) | Historical | Release preparation design. Refers to a `plans/` folder that is not in the repository |
| [superpowers/specs/2026-07-17-flowmap-design.md](superpowers/specs/2026-07-17-flowmap-design.md) | Historical | Original design. Engine names are retired; the banner at the top maps them to the current components |
| [windows-minimum-evidence.json](windows-minimum-evidence.json), [windows-minimum-corrected-source.json](windows-minimum-corrected-source.json) | Evidence data | Machine-readable evidence and source manifest behind the benchmark notes |
| [media/](media/) | Screenshots | Screenshots and the demo animation used by the README |

## Rules for this folder

- A document that describes current behavior says so in its first lines and is updated in the same
  change as the behavior it describes.
- A superseded or historical document keeps its body as a record and gets a banner that names what
  replaced it.
- Test counts and other volatile numbers are not repeated in prose; CI prints them.
- Published documents are written in English. Archival material may keep its original language, and
  its banner says so.
