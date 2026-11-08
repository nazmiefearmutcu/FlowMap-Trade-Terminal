/**
 * Loose handle onto the test hooks the app publishes on `window`
 * (`__flowmapLive`, `__flowmapTest`, `__sc`). Specs read renderer and store
 * internals by name, and those internals are not part of any typed API, so the
 * shape is open. The one `any` lives here instead of at every call site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LooseProbe = any;
