# FlowMap 1.6.2

FlowMap 1.6.2 fixes the top bar on narrow windows, makes the Pixel style cover the whole window, and shows the installed version in the window. The full list is in the [changelog](../CHANGELOG.md).

## What changed

- **Top bar on narrow windows.** The top bar needed about 1620 px. In a narrower window the controls on its right (mode, status, clock, PNG, Rail, Research, Settings) were pushed outside the window. The bar now drops secondary items step by step as the window narrows: the macro ticker, the extra capability chips, the search shortcut hint, the wordmark, the word "Settings" (the gear stays), the SIM chip and the clock zone. If the items still do not fit, the bar wraps to a second row, so no control is ever outside the window.
- **Pixel interface style.** Settings > Display > *Interface style* (named *Chart style* in 1.6.0) = *Pixel* now changes the whole window, not only the chart. Corners are square, shadows are hard two-pixel offsets, the top and bottom bars are flat with a small checker, and labels are set in Pixelify Sans. Figures keep the monospace face, so columns of numbers stay aligned. The FlowMap wordmark is drawn on a pixel grid. Colours come from the active theme, so the style works with every theme. *Normal* is unchanged and is still the default.
- **Version label.** The bottom-left corner of the window shows the installed version, for example `v1.6.2`.

## Licences

Pixelify Sans is bundled under the SIL Open Font License 1.1. Its licence text is in the About panel, and each release attaches it as `LICENSE-pixelify-sans.txt`, listed in `SHA256SUMS`.

## Known limits

The known limits of 1.6.0 still apply, including the unsigned installers. See the [1.6.0 release notes](release-notes-1.6.0.md#known-limits).
