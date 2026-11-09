# Internationalisation rules

The i18n module (`client/src/i18n/`) ships two tables, `en.ts` and `tr.ts`, and the helpers that read them. This file records the rules a change must follow when it adds or changes a visible string, a number, a price or a time.

## Rules

- `en.ts` is the source of truth. Every key exists there.
- `tr.ts` may omit a key. A missing Turkish entry falls back to English. A key missing from both tables would render as the raw key, so `coverage.test.ts` fails for every `t('...')` literal that has no English entry.
- Every visible string goes through `t()`, including the feature panes (drawings, indicators, alerts, the research drawer, the desk). A new key lands in `en.ts` and `tr.ts` in the same change.
- Placeholders (`{name}`) must match between the two tables. `coverage.test.ts` checks this for every key that both tables define.
- Components use `useT()`, so they re-render when the locale changes. Modules that are not React components use `t()` from `index.ts`.
- Count nouns: a `<key>.one` entry is used when the call's `count` is exactly 1 and its `total`, if passed, is 0 or 1, so "1 symbol" and "1 of 1 venue" read correctly. Add the `.one` entry to both tables; Turkish repeats the same text. Pass the count already formatted with `formatNumber`; the match is on the printed text.
- Keys built at run time (for example `theme.<id>.name`) cannot be found by the literal scan. Their families are listed in `coverage.test.ts`. Add the family there when you add a new dynamic key.

## Numbers, prices and time

- `client/src/i18n/format.ts` owns number, size, date and clock formatting.
- Prices use `formatPrice`: a `.` decimal point and no digit grouping, so a price reads the same on every panel.
- Other quantities use the UI locale: `formatNumber`, `formatFixed` (percentages, rates, seconds) and `formatSizeCompact` (resting size). Turkish prints `4,00`. Components must not call `toLocaleString` or `toFixed` for display text.
- Clock times follow the time-zone preference (`formatClock`, `zoneLabel`). The top-bar stream clock is always UTC. Session-relative simulation times are never converted.

## Stored preferences

- Locale: `localStorage` key `flowmap.locale` (`en` or `tr`), restored by `initLocale()` at boot from `client/src/main.tsx`.
- Clock time zone: `flowmap.timeZone` (`local`, `utc` or `exchange`), restored when `format.ts` loads.

## Adding a string

1. Add the English key to `en.ts`, next to related keys.
2. Add the Turkish entry to `tr.ts` with the same placeholders.
3. Call `t('key', vars)` at the call site.
4. Run `npx vitest run src/i18n` from `client/`.
