import { afterEach, describe, expect, it, vi } from 'vitest';

import { lazyLocalStorage, lazyStorageAccessor, safeLocalStorage } from './safeStorage';

describe('safeLocalStorage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the browser storage when it is readable', () => {
    expect(safeLocalStorage()).toBe(window.localStorage);
  });

  it('returns null instead of throwing when the storage property itself throws (blocked site storage)', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('storage is denied', 'SecurityError');
    });
    expect(safeLocalStorage()).toBeNull();
  });
});

describe('lazyStorageAccessor', () => {
  it('reads the storage on the first call only and reuses the result', () => {
    const storage = window.localStorage;
    const read = vi.fn(() => storage);
    const get = lazyStorageAccessor(read);
    expect(read).not.toHaveBeenCalled();
    expect(get()).toBe(storage);
    expect(get()).toBe(storage);
    expect(get()).toBe(storage);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('caches a null result too, so a blocked profile is probed once', () => {
    const read = vi.fn((): Storage | null => null);
    const get = lazyStorageAccessor(read);
    expect(get()).toBeNull();
    expect(get()).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('turns a throwing read into null and caches that too', () => {
    const read = vi.fn((): Storage | null => {
      throw new DOMException('storage is denied', 'SecurityError');
    });
    const get = lazyStorageAccessor(read);
    expect(() => get()).not.toThrow();
    expect(get()).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('keeps a separate cache for each accessor', () => {
    const first = lazyStorageAccessor(() => null);
    const second = lazyStorageAccessor(() => window.localStorage);
    expect(first()).toBeNull();
    expect(second()).toBe(window.localStorage);
  });
});

describe('lazyLocalStorage', () => {
  it('returns the same browser storage on every call', () => {
    expect(lazyLocalStorage()).toBe(window.localStorage);
    expect(lazyLocalStorage()).toBe(lazyLocalStorage());
  });
});
