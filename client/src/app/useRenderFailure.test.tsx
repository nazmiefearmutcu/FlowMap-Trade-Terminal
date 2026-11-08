import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Renderer } from '../gl/renderer';
import { RENDER_FAILURE_POLL_MS, RENDER_FAILURE_POLLS, useRenderFailure } from './useRenderFailure';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let failure: string | null = null;
const rendererRef = { current: { getRenderFailure: (): string | null => failure } as Pick<Renderer, 'getRenderFailure'> };

function Probe(): JSX.Element {
  const [value] = useRenderFailure(rendererRef, 0);
  return <span data-testid="failure">{value ?? ''}</span>;
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  failure = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function text(): string {
  return container.querySelector('[data-testid="failure"]')?.textContent ?? '';
}

function poll(times: number): void {
  for (let i = 0; i < times; i++) {
    act(() => {
      vi.advanceTimersByTime(RENDER_FAILURE_POLL_MS);
    });
  }
}

describe('useRenderFailure', () => {
  it('surfaces a failure only after it survives the consecutive-poll threshold', () => {
    failure = 'shader link failed';
    poll(RENDER_FAILURE_POLLS - 1);
    expect(text()).toBe('');
    poll(1);
    expect(text()).toBe('shader link failed');
  });

  it('clears the surfaced failure on the next clean frame', () => {
    failure = 'shader link failed';
    poll(RENDER_FAILURE_POLLS);
    expect(text()).toBe('shader link failed');
    failure = null;
    poll(1);
    expect(text()).toBe('');
  });

  it('ignores a single bad frame', () => {
    failure = 'one bad frame';
    poll(1);
    failure = null;
    poll(RENDER_FAILURE_POLLS);
    expect(text()).toBe('');
  });
});
