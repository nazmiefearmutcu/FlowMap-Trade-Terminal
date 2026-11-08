import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setSingleKeyShortcutsEnabled } from '../input/shortcutPrefs';
import { useHelpToggle } from './useShellKeys';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let open = false;

function Probe(): null {
  [open] = useHelpToggle();
  return null;
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  open = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setSingleKeyShortcutsEnabled(true);
});

function press(key: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

describe('useHelpToggle', () => {
  it('toggles the shortcuts overlay on ? and only on ?', () => {
    press('x');
    expect(open).toBe(false);
    press('?');
    expect(open).toBe(true);
    press('?');
    expect(open).toBe(false);
  });

  it('stays silent when the single-key shortcuts are switched off', () => {
    setSingleKeyShortcutsEnabled(false);
    press('?');
    expect(open).toBe(false);
  });
});
