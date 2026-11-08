/**
 * DrawToolbar tests: visibility toggle (`D` + the exported
 * toggleDrawToolbar), tool arming, swatch/width styling, undo/redo
 * enablement and the confirm-guarded clear-all.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetDrawingsForTest, setDrawingsStorage, toggleDrawToolbar, useDrawingsStore } from '../drawings/store';
import type { StorageLike } from '../drawings/persist';
import { setLocale } from '../i18n';
import { setSingleKeyShortcutsEnabled } from '../input/shortcutPrefs';
import { DrawToolbar } from './DrawToolbar';
import { DRAWING_INK_SWATCHES } from '../theme/drawInks';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLElement; root: Root }> = [];
let storage: StorageLike;

function memStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function render(node: JSX.Element): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
  mounted.push({ container, root });
  return container;
}

function btn(root: HTMLElement, label: string): HTMLButtonElement {
  const el = root.querySelector(`[aria-label="${label}"]`);
  expect(el, `button ${label}`).not.toBeNull();
  return el as HTMLButtonElement;
}

function fireKey(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  });
}

beforeEach(() => {
  resetDrawingsForTest();
  storage = memStorage();
  setDrawingsStorage(storage);
});

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
});

describe('visibility', () => {
  it('a held D toggles the panel once, not on every auto-repeat', () => {
    const root = render(<DrawToolbar />);
    fireKey('d');
    expect(root.querySelector('[data-testid="draw-toolbar"]')).not.toBeNull();
    fireKey('d', { repeat: true });
    expect(root.querySelector('[data-testid="draw-toolbar"]')).not.toBeNull();
  });

  it('mounts hidden; D toggles; the exported fn toggles too', () => {
    const root = render(<DrawToolbar />);
    expect(root.querySelector('[data-testid="draw-toolbar"]')).toBeNull();
    fireKey('d');
    expect(root.querySelector('[data-testid="draw-toolbar"]')).not.toBeNull();
    fireKey('d');
    expect(root.querySelector('[data-testid="draw-toolbar"]')).toBeNull();
    act(() => toggleDrawToolbar());
    expect(root.querySelector('[data-testid="draw-toolbar"]')).not.toBeNull();
  });

  it('D is silent while single-key shortcuts are switched off (WCAG 2.1.4)', () => {
    render(<DrawToolbar />);
    setSingleKeyShortcutsEnabled(false);
    try {
      fireKey('d');
      expect(useDrawingsStore.getState().toolbarVisible).toBe(false);
    } finally {
      setSingleKeyShortcutsEnabled(true);
    }
    fireKey('d');
    expect(useDrawingsStore.getState().toolbarVisible).toBe(true);
  });

  it('never hijacks modified D or typing targets', () => {
    render(<DrawToolbar />);
    fireKey('d', { ctrlKey: true });
    expect(useDrawingsStore.getState().toolbarVisible).toBe(false);
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
    expect(useDrawingsStore.getState().toolbarVisible).toBe(false); // editable target passes
    input.remove();
    fireKey('d');
    expect(useDrawingsStore.getState().toolbarVisible).toBe(true);
  });
});

describe('tools + style', () => {
  it('arms a tool on click (aria-pressed follows), select disarms', () => {
    const root = render(<DrawToolbar />);
    act(() => toggleDrawToolbar());
    const trend = btn(root, 'Trend line');
    expect(trend.getAttribute('aria-pressed')).toBe('false');
    act(() => trend.click());
    expect(useDrawingsStore.getState().tool).toBe('trendline');
    expect(trend.getAttribute('aria-pressed')).toBe('true');
    act(() => btn(root, 'Select / move drawings').click());
    expect(useDrawingsStore.getState().tool).toBeNull();
  });

  it('swatches set the default style; width cycles', () => {
    const root = render(<DrawToolbar />);
    act(() => toggleDrawToolbar());
    const blue = DRAWING_INK_SWATCHES[1];
    expect(root.querySelector(`[aria-label="Drawing color ${blue}"]`)).toBeNull(); // named, not a hex
    act(() => btn(root, 'Drawing color Blue').click());
    expect(useDrawingsStore.getState().defaultStyle.color).toBe(blue);
    expect(useDrawingsStore.getState().defaultStyle.width).toBe(2);
    act(() => btn(root, 'Stroke width').click()); // 2 → 4
    expect(useDrawingsStore.getState().defaultStyle.width).toBe(4);
    act(() => btn(root, 'Stroke width').click()); // 4 → 1
    expect(useDrawingsStore.getState().defaultStyle.width).toBe(1);
  });

  it('a swatch recolors the SELECTED drawing immediately', () => {
    render(<DrawToolbar />);
    act(() => toggleDrawToolbar());
    const st = useDrawingsStore.getState();
    st.setScope('crypto', 'TEST');
    st.armTool('hline');
    const d = st.addDraftPoint({ tNs: 0n, price: 5 })!;
    useDrawingsStore.getState().setDefaultStyle({ color: '#123123' });
    expect(useDrawingsStore.getState().items.find((x) => x.id === d.id)!.style.color).toBe('#123123');
  });
});

describe('undo / redo / clear-all', () => {
  function seedTwo(): void {
    act(() => {
      const st = useDrawingsStore.getState();
      st.setScope('crypto', 'TEST');
      for (const price of [1, 2]) {
        st.armTool('hline');
        st.addDraftPoint({ tNs: 0n, price });
      }
    });
  }

  it('undo/redo buttons mirror the stacks', () => {
    const root = render(<DrawToolbar />);
    act(() => toggleDrawToolbar());
    const undo = btn(root, 'Undo drawing change');
    const redo = btn(root, 'Redo drawing change');
    expect(undo.disabled).toBe(true);
    expect(redo.disabled).toBe(true);
    seedTwo();
    act(() => undo.click());
    expect(useDrawingsStore.getState().items.length).toBe(1);
    expect(redo.disabled).toBe(false);
    act(() => redo.click());
    expect(useDrawingsStore.getState().items.length).toBe(2);
  });

  it('clear-all asks confirm and wipes (undoable)', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const root = render(<DrawToolbar />);
    act(() => toggleDrawToolbar());
    seedTwo();
    const clear = btn(root, 'Clear all drawings');
    expect(clear.disabled).toBe(false);
    act(() => clear.click());
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('2 drawings'));
    expect(useDrawingsStore.getState().items.length).toBe(0);
    act(() => btn(root, 'Undo drawing change').click());
    expect(useDrawingsStore.getState().items.length).toBe(2);
  });

  it('declining confirm keeps everything', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const root = render(<DrawToolbar />);
    act(() => toggleDrawToolbar());
    seedTwo();
    act(() => btn(root, 'Clear all drawings').click());
    expect(useDrawingsStore.getState().items.length).toBe(2);
  });
});

describe('Turkish locale', () => {
  afterEach(() => {
    setLocale('en');
  });

  it('labels every control in Turkish and leaves no English tool or clear label behind', () => {
    setLocale('tr');
    const root = render(<DrawToolbar />);
    act(() => toggleDrawToolbar());
    expect(root.querySelector('[aria-label="Çizim araçları"]')).not.toBeNull();
    expect(btn(root, 'Trend çizgisi')).toBeDefined();
    expect(btn(root, 'Yatay ışın (sağa uzanır)')).toBeDefined();
    expect(btn(root, 'Çizim değişikliğini geri al').title).toBe('Geri al (Ctrl+Z)');
    expect(btn(root, 'Tüm çizimleri temizle')).toBeDefined();
    const english = ['Trend line', 'Horizontal line', 'Select / move drawings', 'Clear all drawings', 'Stroke width', 'Undo drawing change'];
    for (const label of english) {
      expect(root.querySelector(`[aria-label="${label}"]`), label).toBeNull();
    }
  });

  it('asks the Turkish clear-all question with the count and the chart name', () => {
    setLocale('tr');
    const root = render(<DrawToolbar />);
    act(() => {
      const st = useDrawingsStore.getState();
      st.setScope('crypto', 'TEST');
      st.armTool('hline');
      st.addDraftPoint({ tNs: 0n, price: 1 });
      st.armTool('hline');
      st.addDraftPoint({ tNs: 0n, price: 2 });
    });
    act(() => toggleDrawToolbar());
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    act(() => btn(root, 'Tüm çizimleri temizle').click());
    expect(confirm).toHaveBeenCalledWith('TEST üzerindeki 2 çizimin tümü silinsin mi?');
  });
});

describe('keyboard: one Tab stop with roving arrows (WAI-ARIA toolbar)', () => {
  const stops = (root: HTMLElement): HTMLButtonElement[] =>
    Array.from(root.querySelectorAll<HTMLButtonElement>('[data-testid="draw-toolbar"] button'));

  it('exposes exactly one button in the Tab order, starting on Select', () => {
    const root = render(<DrawToolbar />);
    act(() => toggleDrawToolbar());
    const tabbable = stops(root).filter((b) => b.tabIndex === 0);
    expect(tabbable.map((b) => b.getAttribute('aria-label'))).toEqual(['Select / move drawings']);
    expect(root.querySelector('[data-testid="draw-toolbar"]')!.getAttribute('aria-orientation')).toBe('vertical');
  });

  it('ArrowDown and ArrowUp move focus between the enabled buttons, and Home/End jump to the ends', () => {
    const root = render(<DrawToolbar />);
    act(() => toggleDrawToolbar());
    const bar = root.querySelector('[data-testid="draw-toolbar"]') as HTMLElement;
    const select = btn(root, 'Select / move drawings');
    act(() => select.focus());
    const key = (k: string) => act(() => {
      (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    });
    key('ArrowDown');
    expect(document.activeElement).toBe(btn(root, 'Trend line'));
    expect(btn(root, 'Trend line').tabIndex).toBe(0);
    expect(select.tabIndex).toBe(-1);
    key('ArrowUp');
    expect(document.activeElement).toBe(select);
    key('ArrowUp'); // wraps to the last enabled button
    const enabled = stops(bar).filter((b) => !b.disabled);
    expect(document.activeElement).toBe(enabled[enabled.length - 1]);
    key('Home');
    expect(document.activeElement).toBe(select);
    key('End');
    expect(document.activeElement).toBe(enabled[enabled.length - 1]);
  });

  it('skips the disabled undo, redo and clear buttons', () => {
    const root = render(<DrawToolbar />);
    act(() => toggleDrawToolbar());
    const undo = btn(root, 'Undo drawing change');
    expect(undo.disabled).toBe(true);
    expect(undo.tabIndex).toBe(-1);
    act(() => btn(root, 'Select / move drawings').focus());
    const key = (k: string) => act(() => {
      (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    });
    key('End');
    // Clear, redo and undo are all disabled in an empty session: End lands on the stroke-width stepper.
    expect(document.activeElement).toBe(btn(root, 'Stroke width'));
    expect(btn(root, 'Stroke width').tabIndex).toBe(0);
    key('ArrowDown'); // the stepper is last, so ArrowDown wraps to Select
    expect(document.activeElement).toBe(btn(root, 'Select / move drawings'));
  });
});
