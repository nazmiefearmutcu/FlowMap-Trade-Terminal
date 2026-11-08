import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '../i18n';
import { ErrorBoundary, errorDetailsText } from './ErrorBoundary';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function Boom(): JSX.Element {
  throw new Error('panel exploded');
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(navigator, 'clipboard');
  setLocale('en');
  vi.restoreAllMocks();
});

function renderBoom(): void {
  act(() => {
    root.render(<ErrorBoundary><Boom /></ErrorBoundary>);
  });
}

describe('ErrorBoundary', () => {
  it('renders children untouched when nothing throws', () => {
    act(() => {
      root.render(<ErrorBoundary><p>fine</p></ErrorBoundary>);
    });
    expect(container.textContent).toBe('fine');
  });

  it('shows the title, a technical-details disclosure, copy and reload actions', () => {
    renderBoom();
    const card = container.querySelector('[data-testid="app-crash"]')!;
    expect(card.getAttribute('role')).toBe('alert');
    expect(card.querySelector('.app-crash__title')?.textContent).toBe('FlowMap hit an unrecoverable error');
    const disclosure = card.querySelector('details.app-crash__disclosure')!;
    expect(disclosure.querySelector('summary')?.textContent).toBe('Technical details');
    expect(disclosure.querySelector('pre')?.textContent).toBe('panel exploded');
    const buttons = [...card.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toEqual(['Copy details', 'Reload FlowMap']);
  });

  it('copies the error details to the clipboard and reports success', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderBoom();
    await act(async () => {
      (container.querySelector('[data-testid="app-crash-copy"]') as HTMLButtonElement).click();
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toContain('panel exploded');
    expect(container.querySelector('[data-testid="app-crash-copy-state"]')?.textContent).toBe('Details copied to the clipboard.');
  });

  it('reports a failed copy without throwing', async () => {
    const writeText = vi.fn(async (_text: string) => { throw new Error('denied'); });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderBoom();
    await act(async () => {
      (container.querySelector('[data-testid="app-crash-copy"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="app-crash-copy-state"]')?.textContent).toBe('Could not copy. Select the technical details instead.');
  });

  it('localizes the card when Turkish is active', () => {
    setLocale('tr');
    renderBoom();
    expect(container.querySelector('.app-crash__title')?.textContent).toBe('FlowMap beklenmeyen bir hatayla karşılaştı');
    expect(container.querySelector('summary')?.textContent).toBe('Teknik ayrıntılar');
  });
});

describe('errorDetailsText', () => {
  it('prefers a stack that already starts with the message', () => {
    const error = new Error('bad');
    error.stack = 'Error: bad\n    at x';
    expect(errorDetailsText(error)).toBe('Error: bad\n    at x');
  });

  it('prepends the message when the stack does not carry it', () => {
    const error = new Error('bad');
    error.stack = '    at x';
    expect(errorDetailsText(error)).toBe('bad\n\n    at x');
  });

  it('falls back to the message alone without a stack', () => {
    const error = new Error('bad');
    error.stack = undefined;
    expect(errorDetailsText(error)).toBe('bad');
  });
});
