/**
 * The browser's localStorage, or null when it cannot be had. Reading the
 * `window.localStorage` PROPERTY throws a SecurityError when site storage is
 * blocked (some webview and privacy profiles), so every boot-time read goes
 * through here: a blocked profile then degrades to defaults and session-only
 * preferences instead of a blank window.
 */
export function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * A getter that runs `read` on its first call and returns that result from then
 * on, `null` included, so a hot path pays for the storage lookup once. A `read`
 * that throws counts as no storage. Each call to this factory keeps its own cache.
 */
export function lazyStorageAccessor(read: () => Storage | null = safeLocalStorage): () => Storage | null {
  let resolved = false;
  let storage: Storage | null = null;
  return () => {
    if (!resolved) {
      try {
        storage = read();
      } catch {
        storage = null;
      }
      resolved = true;
    }
    return storage;
  };
}

const sharedLocalStorage = lazyStorageAccessor();

/**
 * The browser's localStorage through a shared, memoised accessor: read on the
 * first call, cached afterwards (`null` included), and never throws. Use it on
 * paths that run per message or per render; a one-off boot read can call
 * {@link safeLocalStorage} directly.
 */
export function lazyLocalStorage(): Storage | null {
  return sharedLocalStorage();
}
