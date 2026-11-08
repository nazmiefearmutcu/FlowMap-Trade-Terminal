import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaneResizer } from './PaneResizer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

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

function press(el: Element, key: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
});

describe('PaneResizer accessible value', () => {
  it('announces a pixel pane in pixels and a ratio splitter as a percentage', () => {
    const pixel = render(
      <PaneResizer axis="x" value={260} min={200} max={400} variable="--rail-w" label="rail" onCommit={vi.fn()} />,
    );
    expect(pixel.querySelector('[role="separator"]')?.getAttribute('aria-valuetext')).toBe('260 px');
    const ratio = render(
      <PaneResizer axis="y" value={0.6} min={0.2} max={0.8} variable="--dom-ratio" label="ratio" onCommit={vi.fn()} ratio />,
    );
    expect(ratio.querySelector('[role="separator"]')?.getAttribute('aria-valuetext')).toBe('60%');
  });
});

describe('PaneResizer keyboard direction', () => {
  it('grows a right-docked pixel pane when ArrowLeft is pressed, as dragging left does', () => {
    const onCommit = vi.fn();
    const container = render(
      <PaneResizer axis="x" value={260} min={200} max={400} variable="--rail-w" label="rail" onCommit={onCommit} />,
    );
    press(container.querySelector('[role="separator"]')!, 'ArrowLeft');
    expect(onCommit).toHaveBeenLastCalledWith(276);
    press(container.querySelector('[role="separator"]')!, 'ArrowRight');
    expect(onCommit).toHaveBeenLastCalledWith(244);
  });

  it('keeps ratio splitters on the natural direction (ArrowDown grows the lower pane)', () => {
    const onCommit = vi.fn();
    const container = render(
      <PaneResizer axis="y" value={0.5} min={0.2} max={0.8} variable="--dom-ratio" label="ratio" onCommit={onCommit} ratio />,
    );
    press(container.querySelector('[role="separator"]')!, 'ArrowDown');
    expect(onCommit.mock.calls[0][0]).toBeCloseTo(0.55);
    press(container.querySelector('[role="separator"]')!, 'ArrowUp');
    expect(onCommit.mock.calls[1][0]).toBeCloseTo(0.45);
  });
});
