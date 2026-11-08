import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DepthChannelHotkey } from './DepthChannelHotkey';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}

it('cycles the depth channel once per C press', () => {
  const onCycle = vi.fn();
  act(() => root.render(<DepthChannelHotkey onCycle={onCycle} />));
  press(window, 'c');
  press(window, 'C');
  expect(onCycle).toHaveBeenCalledTimes(2);
});

it('ignores the OS auto-repeat keydowns of a held C', () => {
  const onCycle = vi.fn();
  act(() => root.render(<DepthChannelHotkey onCycle={onCycle} />));
  press(window, 'c');
  press(window, 'c', { repeat: true });
  press(window, 'c', { repeat: true });
  expect(onCycle).toHaveBeenCalledTimes(1);
});

it('does not cycle while typing in a field or with a chord', () => {
  const onCycle = vi.fn();
  act(() => root.render(<DepthChannelHotkey onCycle={onCycle} />));
  const input = document.createElement('input');
  host.appendChild(input);
  press(input, 'c');
  press(window, 'c', { ctrlKey: true });
  expect(onCycle).not.toHaveBeenCalled();
});
