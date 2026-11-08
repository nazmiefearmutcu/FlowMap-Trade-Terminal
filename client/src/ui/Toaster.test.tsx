/**
 * Toaster tests: push/cap/dismiss, auto-dismiss + hover pause,
 * ARIA live region, severity styling, the window.__flowmapToast hook,
 * and i18n'd dismiss label.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '../i18n';
import {
  DEFAULT_TTL_MS,
  MAX_TOASTS,
  Toaster,
  dismissToast,
  getToasts,
  pauseToast,
  resetToasts,
  resumeToast,
  toast,
  type Toast,
} from './Toaster';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function render(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<Toaster />);
  });
  mounted.push({ container, root });
  return container;
}

function stack(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="toasts"]');
}

beforeEach(() => {
  resetToasts();
});

afterEach(() => {
  vi.useRealTimers();
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  delete window.__flowmapToast;
  resetToasts();
  setLocale('en');
});

describe('store', () => {
  it('pushes toasts with defaults (info kind, 5s ttl)', () => {
    const entry = toast('hello');
    expect(entry.kind).toBe('info');
    expect(entry.ttlMs).toBe(DEFAULT_TTL_MS);
    expect(getToasts().map((t) => t.message)).toEqual(['hello']);
  });

  it('caps the stack at 5, dropping the oldest first', () => {
    for (let i = 1; i <= 6; i++) toast(`m${i}`);
    expect(getToasts().length).toBe(MAX_TOASTS);
    expect(getToasts().map((t) => t.message)).toEqual(['m2', 'm3', 'm4', 'm5', 'm6']);
  });

  it('dismissToast removes exactly its id', () => {
    const a = toast('a');
    const b = toast('b');
    dismissToast(a.id);
    expect(getToasts().map((t) => t.id)).toEqual([b.id]);
    dismissToast(999); // unknown id — no-op
    expect(getToasts().length).toBe(1);
  });
});

describe('Toaster component', () => {
  it('renders no visible stack while empty, but keeps both announcers mounted', () => {
    const container = render();
    expect(stack(container)).toBeNull();
    const polite = container.querySelector('[data-testid="toast-announcer"]');
    const alert = container.querySelector('[data-testid="toast-alert-announcer"]');
    expect(polite!.getAttribute('role')).toBe('status');
    expect(polite!.getAttribute('aria-live')).toBe('polite');
    expect(alert!.getAttribute('role')).toBe('alert');
    expect(polite!.textContent).toBe('');
    expect(alert!.textContent).toBe('');
  });

  it('announces error toasts through the alert region and other kinds through the polite one', () => {
    const container = render();
    act(() => {
      toast('done', { kind: 'success' });
    });
    expect(container.querySelector('[data-testid="toast-announcer"]')!.textContent).toBe('done');
    expect(container.querySelector('[data-testid="toast-alert-announcer"]')!.textContent).toBe('');
    act(() => {
      toast('bad', { kind: 'error' });
    });
    expect(container.querySelector('[data-testid="toast-alert-announcer"]')!.textContent).toBe('bad');
    // Visible rows carry no per-item role: the announcers are the only live output.
    expect(container.querySelector('.toast--error')!.getAttribute('role')).toBeNull();
  });

  it('does not re-announce an older toast when a newer one is dismissed', () => {
    const container = render();
    let first!: Toast;
    act(() => {
      first = toast('first');
      toast('second');
    });
    act(() => dismissToast(first.id + 1));
    expect(container.querySelector('[data-testid="toast-announcer"]')!.textContent).toBe('second');
    act(() => dismissToast(first.id));
    expect(container.querySelector('[data-testid="toast-announcer"]')!.textContent).toBe('second');
  });

  it('keeps errors on screen twice as long as the default ttl', () => {
    vi.useFakeTimers();
    const container = render();
    act(() => {
      toast('bad', { kind: 'error' });
    });
    act(() => vi.advanceTimersByTime(DEFAULT_TTL_MS + 1));
    expect(container.querySelectorAll('.toast').length).toBe(1);
    act(() => vi.advanceTimersByTime(DEFAULT_TTL_MS));
    expect(container.querySelectorAll('.toast').length).toBe(0);
  });

  it('pauses the timer while keyboard focus is inside the toast', () => {
    vi.useFakeTimers();
    const container = render();
    act(() => {
      toast('focus me');
    });
    const closeBtn = container.querySelector('.toast__close') as HTMLButtonElement;
    act(() => closeBtn.focus());
    act(() => vi.advanceTimersByTime(DEFAULT_TTL_MS * 3));
    expect(container.querySelectorAll('.toast').length).toBe(1);
    act(() => (document.activeElement as HTMLElement).blur());
    act(() => vi.advanceTimersByTime(DEFAULT_TTL_MS + 1));
    expect(container.querySelectorAll('.toast').length).toBe(0);
  });

  it('keeps the timer held while keyboard focus is still inside after the pointer leaves', () => {
    vi.useFakeTimers();
    const container = render();
    let entry!: ReturnType<typeof toast>;
    act(() => {
      entry = toast('hover and focus', { ttlMs: 1000 });
    });
    const node = container.querySelector(`[data-testid="toast-${entry.id}"]`) as HTMLElement;
    const closeBtn = container.querySelector(`[data-testid="toast-close-${entry.id}"]`) as HTMLButtonElement;
    act(() => closeBtn.focus());
    act(() => node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    act(() => node.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    // The pointer left, but focus is still inside: the timer must stay paused.
    act(() => vi.advanceTimersByTime(5000));
    expect(container.querySelectorAll('.toast').length).toBe(1);
    act(() => closeBtn.blur());
    act(() => vi.advanceTimersByTime(1000));
    expect(container.querySelectorAll('.toast').length).toBe(0);
  });

  it('keeps the timer held while the pointer is still over the toast after focus leaves', () => {
    vi.useFakeTimers();
    const container = render();
    let entry!: ReturnType<typeof toast>;
    act(() => {
      entry = toast('hover then focus', { ttlMs: 1000 });
    });
    const node = container.querySelector(`[data-testid="toast-${entry.id}"]`) as HTMLElement;
    const closeBtn = container.querySelector(`[data-testid="toast-close-${entry.id}"]`) as HTMLButtonElement;
    act(() => node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    act(() => closeBtn.focus());
    act(() => closeBtn.blur());
    act(() => vi.advanceTimersByTime(5000));
    expect(container.querySelectorAll('.toast').length).toBe(1);
    act(() => node.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    act(() => vi.advanceTimersByTime(1000));
    expect(container.querySelectorAll('.toast').length).toBe(0);
  });

  it('evicts the oldest info toast before an error, and clears the evicted timer', () => {
    vi.useFakeTimers();
    const e = toast('keep me', { kind: 'error' });
    for (let i = 0; i < MAX_TOASTS + 2; i += 1) toast(`info ${i}`);
    const messages = getToasts().map((t) => t.message);
    expect(messages).toContain('keep me');
    expect(messages).not.toContain('info 0');
    expect(getToasts().length).toBe(MAX_TOASTS);
    expect(e.kind).toBe('error');
    // The info toasts expire on their own ttl; the error outlives them.
    vi.advanceTimersByTime(DEFAULT_TTL_MS + 1);
    expect(getToasts().map((t) => t.kind)).toEqual(['error']);
    vi.advanceTimersByTime(DEFAULT_TTL_MS);
    expect(getToasts().length).toBe(0);
  });

  it('renders messages, severity classes, and one polite live region', () => {
    const container = render();
    act(() => {
      toast('filled', { kind: 'warn' });
      toast('done', { kind: 'success' });
      toast('bad', { kind: 'error' });
    });
    const region = stack(container)!;
    expect(region.getAttribute('role')).toBeNull();
    expect(container.querySelector('[data-testid="toast-announcer"]')!.getAttribute('aria-live')).toBe('polite');
    const toasts = region.querySelectorAll('.toast');
    expect(toasts.length).toBe(3);
    expect(toasts[0].className).toContain('toast--warn');
    expect(toasts[1].className).toContain('toast--success');
    expect(toasts[2].className).toContain('toast--error');
  });

  it('shows at most 5 DOM rows when a sixth arrives', () => {
    const container = render();
    act(() => {
      for (let i = 1; i <= 6; i++) toast(`m${i}`);
    });
    expect(stack(container)!.querySelectorAll('.toast').length).toBe(5);
    expect(stack(container)!.textContent).not.toContain('m1');
  });

  it('dismisses via the close button', () => {
    const container = render();
    let entry!: ReturnType<typeof toast>;
    act(() => {
      entry = toast('close me');
    });
    const button = container.querySelector(`[data-testid="toast-close-${entry.id}"]`)!;
    expect(button.getAttribute('aria-label')).toBe('Dismiss notification');
    act(() => {
      (button as HTMLButtonElement).click();
    });
    expect(container.querySelectorAll('.toast').length).toBe(0);
  });

  it('uses the localized dismiss label', () => {
    const container = render();
    let entry!: ReturnType<typeof toast>;
    act(() => {
      setLocale('tr');
      entry = toast('kapat beni');
    });
    expect(
      container.querySelector(`[data-testid="toast-close-${entry.id}"]`)!.getAttribute('aria-label'),
    ).toBe('Bildirimi kapat');
  });
});

describe('timing', () => {
  it('auto-dismisses after the ttl (default 5s)', () => {
    vi.useFakeTimers();
    const container = render();
    act(() => {
      toast('gone soon', { ttlMs: 1000 });
    });
    act(() => vi.advanceTimersByTime(999));
    expect(container.querySelectorAll('.toast').length).toBeGreaterThan(0);
    act(() => vi.advanceTimersByTime(1));
    expect(container.querySelectorAll('.toast').length).toBe(0);
  });

  it('hover pauses the timer and leave resumes the remainder', () => {
    vi.useFakeTimers();
    const container = render();
    let entry!: ReturnType<typeof toast>;
    act(() => {
      entry = toast('hover me', { ttlMs: 1000 });
    });
    const node = container.querySelector(`[data-testid="toast-${entry.id}"]`) as HTMLElement;

    act(() => {
      node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => vi.advanceTimersByTime(5000));
    expect(container.querySelectorAll('.toast').length).toBeGreaterThan(0); // paused — far past ttl

    act(() => {
      node.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(container.querySelectorAll('.toast').length).toBe(0);
  });

  it('pause/resume work at the store level too', () => {
    vi.useFakeTimers();
    const container = render();
    let entry!: ReturnType<typeof toast>;
    act(() => {
      entry = toast('store pause', { ttlMs: 500 });
    });
    act(() => pauseToast(entry.id));
    act(() => vi.advanceTimersByTime(10_000));
    expect(container.querySelectorAll('.toast').length).toBeGreaterThan(0);
    act(() => resumeToast(entry.id));
    act(() => vi.advanceTimersByTime(500));
    expect(container.querySelectorAll('.toast').length).toBe(0);
  });
});

describe('window.__flowmapToast hook', () => {
  it('binds on mount, pushes toasts, and unbinds on unmount', () => {
    const container = render();
    expect(typeof window.__flowmapToast).toBe('function');
    act(() => {
      window.__flowmapToast!('from alerts', 'warn');
    });
    expect(getToasts()[0]).toMatchObject({ message: 'from alerts', kind: 'warn' });
    expect(stack(container)!.querySelector('.toast--warn')).not.toBeNull();

    const { root } = mounted[mounted.length - 1];
    act(() => root.unmount());
    mounted.pop();
    expect(window.__flowmapToast).toBeUndefined();
  });
});
