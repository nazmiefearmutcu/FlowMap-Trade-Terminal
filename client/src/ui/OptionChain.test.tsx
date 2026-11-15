import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '../i18n';
import { OptionChainDialog, REFRESH_MS, SPOT_MS } from './OptionChain';
import { pushOverlay, resetOverlays } from './overlayStack';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.UTC(2026, 10, 12, 15, 0, 0); // 2026-11-12 15:00 UTC
const SERIES = [
  { root: 'AAPL', expiry: '2026-11-13', contracts: 6 },
  { root: 'AAPL', expiry: '2026-11-20', contracts: 4 },
];

function side(symbol: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { symbol, bid: 1.5, ask: 1.6, theo: 1.55, iv: 0.25, delta: 0.5, gamma: 0.02, theta: -0.1, vega: 0.2, rho: 0.03, ...over };
}

function chainBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    market: 'equity',
    symbol: 'AAPL',
    status: 'ok',
    underlying: 'NASDAQ:AAPL',
    series: SERIES,
    selected: { root: 'AAPL', expiry: '2026-11-13' },
    strikes: [
      { strike: 90, call: side('OPRA:AAPL261113C90'), put: side('OPRA:AAPL261113P90') },
      { strike: 100, call: side('OPRA:AAPL261113C100'), put: side('OPRA:AAPL261113P100') },
      { strike: 110, call: side('OPRA:AAPL261113C110'), put: side('OPRA:AAPL261113P110') },
    ],
    capturedMs: Date.UTC(2026, 10, 12, 14, 30, 0),
    stale: false,
    source: 'tradingview',
    ...over,
  };
}

/** A `fetch` answer: the body as text, with the status the dialog reads. */
function answer(body: unknown, status = 200): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response;
}

/** Lets the pending fetch chain (fetch, text, parse, state update) run to the end. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

interface MountOptions {
  market?: string;
  symbol?: string;
  onClose?: () => void;
  spot?: number | null;
}

function mount(options: MountOptions = {}): { container: HTMLElement; root: Root; onClose: () => void } {
  const onClose = options.onClose ?? vi.fn();
  const spot = options.spot === undefined ? 100 : options.spot;
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <OptionChainDialog
        market={options.market ?? 'equity'}
        symbol={options.symbol ?? 'AAPL'}
        onClose={onClose}
        spotFn={() => spot}
        nowMs={() => NOW}
      />,
    );
  });
  mounted.push({ container, root });
  return { container, root, onClose };
}

const q = <T extends Element = HTMLElement>(selector: string): T | null => document.querySelector<T>(selector);
const text = (selector: string): string => q(selector)?.textContent ?? '';
const rows = (): HTMLTableRowElement[] => Array.from(document.querySelectorAll<HTMLTableRowElement>('tbody tr'));
const headerTexts = (): string[] =>
  Array.from(document.querySelectorAll('thead tr:nth-child(2) th')).map((th) => th.textContent ?? '');

beforeEach(() => {
  setLocale('en');
  resetOverlays();
});

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  resetOverlays();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setLocale('en');
  // Undo the visibility override of the refresh-timer test, if it ran.
  delete (document as unknown as { visibilityState?: unknown }).visibilityState;
});

describe('OptionChainDialog requests', () => {
  it('requests the chain once on mount and shows the loading text first', async () => {
    const fetch = vi.fn().mockResolvedValue(answer(chainBody()));
    vi.stubGlobal('fetch', fetch);
    mount();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain('/api/options?market=equity&symbol=AAPL');
    expect(q('[data-testid="option-chain-status"]')?.textContent).toBe('Loading the option chain…');
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="option-chain-status"]')?.textContent).not.toContain('Loading');
  });

  it('sends another request when Refresh is pressed, naming the series on screen', async () => {
    const fetch = vi.fn().mockResolvedValue(answer(chainBody()));
    vi.stubGlobal('fetch', fetch);
    mount();
    await settle();
    act(() => q<HTMLButtonElement>('[data-testid="option-chain-refresh"]')!.click());
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1][0])).toContain('/api/options?market=equity&symbol=AAPL&expiry=2026-11-13&root=AAPL');
  });

  it('refreshes after REFRESH_MS while open, and not while the window is hidden', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(answer(chainBody()));
    vi.stubGlobal('fetch', fetch);
    mount();
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(REFRESH_MS - 1);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    await act(async () => {
      vi.advanceTimersByTime(REFRESH_MS);
    });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);

    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    await act(async () => {
      vi.advanceTimersByTime(REFRESH_MS);
    });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe('OptionChainDialog content', () => {
  it('renders the title with the market and symbol, and the underlying', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody())));
    mount();
    await settle();
    expect(text('.option-chain__title')).toBe('Option chain · equity / AAPL');
    expect(text('[data-testid="option-chain-underlying"]')).toContain('NASDAQ:AAPL');
  });

  it('renders one table row per strike, with the strike text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody())));
    mount();
    await settle();
    expect(rows()).toHaveLength(3);
    expect(rows().map((row) => row.querySelector('th.option-chain__strike')?.textContent)).toEqual(['90', '100', '110']);
  });

  it('leaves the empty side of a one-sided strike blank and marks it absent, while a null field prints a dash', async () => {
    const body = chainBody({
      strikes: [
        { strike: 100, call: side('C100'), put: null },
        { strike: 110, call: side('C110', { bid: null }), put: side('P110') },
      ],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(body)));
    mount({ spot: null });
    await settle();
    const [oneSided, full] = rows();

    const putCells = Array.from(oneSided.querySelectorAll('td.is-put'));
    expect(putCells).toHaveLength(5);
    for (const cell of putCells) {
      expect(cell.classList.contains('is-absent')).toBe(true);
      expect(cell.textContent).toBe('');
    }
    expect(Array.from(oneSided.querySelectorAll('td')).some((cell) => cell.textContent === '—')).toBe(false);

    const bidCell = full.querySelector('td.is-call')!;
    expect(bidCell.classList.contains('is-absent')).toBe(false);
    expect(bidCell.textContent).toBe('—');
    expect(full.querySelector('td.is-put.is-absent')).toBeNull();
  });

  it('lists every series in the picker and shows the chosen one in the title line', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody())));
    mount();
    await settle();
    const select = q<HTMLSelectElement>('[data-testid="option-chain-series"]')!;
    expect(select.options).toHaveLength(2);
    expect(select.value).toBe('2026-11-13|AAPL');
    expect(select.options[0].textContent).toContain('AAPL');
    expect(select.options[0].textContent).toContain('in 1 day');
    expect(select.options[0].textContent).toContain('6 contracts');
    expect(select.options[1].textContent).toContain('4 contracts');
  });

  it('sends a second request for the chosen series and hides the table while it loads', async () => {
    let release: () => void = () => undefined;
    const fetch = vi.fn()
      .mockResolvedValueOnce(answer(chainBody()))
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          release = () => resolve(answer(chainBody({ selected: { root: 'AAPL', expiry: '2026-11-20' }, strikes: [{ strike: 200, call: side('C200'), put: null }] })));
        }),
      );
    vi.stubGlobal('fetch', fetch);
    mount();
    await settle();
    expect(q('[data-testid="option-chain-scroll"]')).not.toBeNull();

    const select = q<HTMLSelectElement>('[data-testid="option-chain-series"]')!;
    select.value = '2026-11-20|AAPL';
    act(() => {
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const second = String(fetch.mock.calls[1][0]);
    expect(second).toContain('expiry=2026-11-20');
    expect(second).toContain('root=AAPL');
    expect(q('[data-testid="option-chain-scroll"]')).toBeNull();
    expect(text('[data-testid="option-chain-status"]')).toContain('Loading the option chain…');

    await act(async () => release());
    await settle();
    expect(q('[data-testid="option-chain-scroll"]')).not.toBeNull();
    expect(rows().map((row) => row.querySelector('th.option-chain__strike')?.textContent)).toEqual(['200']);
  });

  it('switches the column headers to the Greeks and sets aria-pressed on the chosen view', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody())));
    mount();
    await settle();
    const prices = q('[data-testid="option-chain-mode-prices"]')!;
    const greeks = q('[data-testid="option-chain-mode-greeks"]')!;
    expect(headerTexts()).toEqual(['Bid', 'Ask', 'Theo', 'IV', 'Delta', 'Delta', 'IV', 'Theo', 'Ask', 'Bid']);
    expect(prices.getAttribute('aria-pressed')).toBe('true');
    expect(greeks.getAttribute('aria-pressed')).toBe('false');

    act(() => greeks.click());
    expect(headerTexts()).toEqual(['Delta', 'Gamma', 'Theta', 'Vega', 'Rho', 'Rho', 'Vega', 'Theta', 'Gamma', 'Delta']);
    expect(prices.getAttribute('aria-pressed')).toBe('false');
    expect(greeks.getAttribute('aria-pressed')).toBe('true');
  });

  it('marks the row nearest the chart price and tints in-the-money cells', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody())));
    mount({ spot: 104 });
    await settle();
    const marked = document.querySelectorAll('[data-testid="option-chain-atm"]');
    expect(marked).toHaveLength(1);
    expect(marked[0].querySelector('th.option-chain__strike')?.textContent).toBe('100');
    expect(marked[0].classList.contains('is-atm')).toBe(true);
    expect(text('[data-testid="option-chain-status"]')).toContain('Chart price 104.00');

    // Calls below 104 (90 and 100) are in the money; puts above it (110) are.
    const [r90, r100, r110] = rows();
    for (const cell of r90.querySelectorAll('td.is-call')) expect(cell.classList.contains('is-itm')).toBe(true);
    for (const cell of r90.querySelectorAll('td.is-put')) expect(cell.classList.contains('is-itm')).toBe(false);
    for (const cell of r100.querySelectorAll('td.is-call')) expect(cell.classList.contains('is-itm')).toBe(true);
    for (const cell of r100.querySelectorAll('td.is-put')) expect(cell.classList.contains('is-itm')).toBe(false);
    for (const cell of r110.querySelectorAll('td.is-call')) expect(cell.classList.contains('is-itm')).toBe(false);
    for (const cell of r110.querySelectorAll('td.is-put')) expect(cell.classList.contains('is-itm')).toBe(true);
  });

  it('marks no row and no in-the-money cell when the chart has no price', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody())));
    mount({ spot: null });
    await settle();
    expect(document.querySelector('[data-testid="option-chain-atm"]')).toBeNull();
    expect(document.querySelector('.is-itm')).toBeNull();
    expect(text('[data-testid="option-chain-status"]')).not.toContain('Chart price');
  });

  it.each([
    ['none', 'The source lists no options for AAPL.'],
    ['unsupported', 'This market has no option chain in this build.'],
    ['unreachable', 'The option source could not be reached. Press Refresh to try again.'],
  ])('shows the %s message and no table', async (status, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody({ status, strikes: [], series: [] }))));
    mount();
    await settle();
    expect(text('[data-testid="option-chain-status"]')).toContain(message);
    expect(q('[data-testid="option-chain-scroll"]')).toBeNull();
    expect(q('.option-chain__table')).toBeNull();
  });

  it('shows the stale alert with the time of the last good reading', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody({ stale: true }))));
    mount();
    await settle();
    const alert = q('[data-testid="option-chain-stale"]')!;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('The last refresh failed.');
    expect(q('[data-testid="option-chain-scroll"]')).not.toBeNull();
  });

  it('shows the error alert for a failed request with no earlier table', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer({ detail: 'internal' }, 500)));
    mount();
    await settle();
    const alert = q('[data-testid="option-chain-error"]')!;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toBe('The engine returned an error (HTTP 500). Press Refresh to try again.');
    expect(alert.textContent).not.toContain('internal');
    expect(q('[data-testid="option-chain-scroll"]')).toBeNull();
  });

  it('keeps the earlier table when a later refresh fails', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(answer(chainBody()))
      .mockResolvedValueOnce(answer({ detail: 'internal' }, 500));
    vi.stubGlobal('fetch', fetch);
    mount();
    await settle();
    expect(rows()).toHaveLength(3);

    act(() => q<HTMLButtonElement>('[data-testid="option-chain-refresh"]')!.click());
    await settle();
    expect(q('[data-testid="option-chain-error"]')).not.toBeNull();
    expect(q('[data-testid="option-chain-scroll"]')).not.toBeNull();
    expect(rows()).toHaveLength(3);
  });
});

describe('OptionChainDialog dismissal and modal contract', () => {
  it('calls onClose on Escape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody())));
    const { onClose } = mount();
    await settle();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('leaves Escape to an overlay that is on top of it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody())));
    const { onClose } = mount();
    await settle();
    const popAbove = pushOverlay('some-other-surface');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
    popAbove();
  });

  it('calls onClose when the backdrop is pressed, but not when the press is inside the panel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody())));
    const { onClose } = mount();
    await settle();
    const panel = q('[data-testid="option-chain"]')!;
    act(() => {
      panel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      q('.option-chain__backdrop')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose from the close button', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody())));
    const { onClose } = mount();
    await settle();
    act(() => q<HTMLButtonElement>('[data-testid="option-chain-close"]')!.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('moves focus to the close button on open', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody())));
    mount();
    await settle();
    expect(document.activeElement).toBe(q('[data-testid="option-chain-close"]'));
  });

  it('is a labelled modal dialog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody())));
    mount();
    await settle();
    const dialog = q('[data-testid="option-chain"]')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBe('option-chain-title');
    expect(document.getElementById(labelId!)?.textContent).toContain('Option chain');
  });

  it('renders the Turkish title in the Turkish locale', async () => {
    setLocale('tr');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody())));
    mount();
    await settle();
    expect(text('.option-chain__title')).toBe('Opsiyon zinciri · equity / AAPL');
  });
});

describe('OptionChainDialog keeps to the series on screen', () => {
  it('drops a pick that failed: the next refresh asks for the series on screen again', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(answer(chainBody()))
      .mockResolvedValueOnce(answer({ error: { code: 'boom', message: 'x' } }, 500))
      .mockResolvedValue(answer(chainBody()));
    vi.stubGlobal('fetch', fetch);
    mount();
    await settle();
    const select = q<HTMLSelectElement>('[data-testid="option-chain-series"]')!;
    act(() => {
      select.value = '2026-11-20|AAPL';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(String(fetch.mock.calls[1][0])).toContain('expiry=2026-11-20');
    // The pick failed: the earlier table and its series stay, and the error is shown.
    expect(q('[data-testid="option-chain-error"]')).not.toBeNull();
    expect(q<HTMLSelectElement>('[data-testid="option-chain-series"]')!.value).toBe('2026-11-13|AAPL');
    expect(rows()).toHaveLength(3);
    act(() => q<HTMLButtonElement>('[data-testid="option-chain-refresh"]')!.click());
    await settle();
    // Not the series the user never got to see.
    expect(String(fetch.mock.calls[2][0])).toContain('expiry=2026-11-13&root=AAPL');
    expect(q('[data-testid="option-chain-error"]')).toBeNull();
  });

  it('keeps asking for the series on screen after an answer that names none', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(answer(chainBody()))
      .mockResolvedValueOnce(answer(chainBody({ status: 'unreachable', selected: null, strikes: [], series: [] })))
      .mockResolvedValue(answer(chainBody()));
    vi.stubGlobal('fetch', fetch);
    mount();
    await settle();
    act(() => q<HTMLButtonElement>('[data-testid="option-chain-refresh"]')!.click());
    await settle();
    act(() => q<HTMLButtonElement>('[data-testid="option-chain-refresh"]')!.click());
    await settle();
    expect(String(fetch.mock.calls[2][0])).toContain('expiry=2026-11-13&root=AAPL');
  });

  it('skips a timer tick while an answer is still on its way, so a slow answer lands', async () => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    const slow = new Promise<Response>((resolve) => { release = resolve; });
    const fetch = vi.fn().mockReturnValueOnce(slow).mockResolvedValue(answer(chainBody()));
    vi.stubGlobal('fetch', fetch);
    mount();
    await act(async () => {
      vi.advanceTimersByTime(REFRESH_MS * 3);
    });
    // Three ticks passed and none of them started a second request over the first.
    expect(fetch).toHaveBeenCalledTimes(1);
    release(answer(chainBody()));
    await settle();
    expect(rows()).toHaveLength(3);
    await act(async () => {
      vi.advanceTimersByTime(REFRESH_MS);
    });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('OptionChainDialog figures', () => {
  it('writes a delta that rounds to zero as zero, never as a negative zero', async () => {
    const strikes = [{ strike: 100, call: side('C', { delta: 0.0004 }), put: side('P', { delta: -0.0004 }) }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody({ strikes }))));
    mount();
    await settle();
    const cells = Array.from(rows()[0].querySelectorAll('td')).map((cell) => cell.textContent);
    expect(cells.filter((value) => value === '0.000')).toHaveLength(2);
    expect(cells.some((value) => value?.startsWith('-0.000'))).toBe(false);
  });

  it('writes the chart price with its own decimals, not with the premiums\' decimals', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody())));
    mount({ spot: 1.15872 });
    await settle();
    expect(text('[data-testid="option-chain-status"]')).toContain('Chart price 1.15872');
  });

  it('writes quotes as fine as the source states them', async () => {
    const strikes = [{ strike: 1.14, call: side('C', { bid: 0.00004, ask: 0.00005, theo: 0.00004 }), put: null }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody({ strikes }))));
    mount({ spot: null });
    await settle();
    const cells = Array.from(rows()[0].querySelectorAll('td')).map((cell) => cell.textContent);
    expect(cells.slice(0, 3)).toEqual(['0.00004', '0.00005', '0.00004']);
  });

  it('without a chart price marks no row and brings the half-delta row into view', async () => {
    const scrolled: Element[] = [];
    const proto = Element.prototype as unknown as { scrollIntoView?: () => void };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = function scrollIntoView(this: Element): void {
      scrolled.push(this);
    };
    try {
      const strikes = [
        { strike: 90, call: side('C90', { delta: 0.9 }), put: side('P90', { delta: -0.1 }) },
        { strike: 100, call: side('C100', { delta: 0.7 }), put: side('P100', { delta: -0.3 }) },
        { strike: 110, call: side('C110', { delta: 0.45 }), put: side('P110', { delta: -0.55 }) },
      ];
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody({ strikes }))));
      mount({ spot: null });
      await settle();
      expect(q('[data-testid="option-chain-atm"]')).toBeNull();
      expect(document.querySelectorAll('.is-itm')).toHaveLength(0);
      expect(scrolled).toHaveLength(1);
      expect(scrolled[0].querySelector('th')?.textContent).toBe('110');
    } finally {
      if (original === undefined) delete proto.scrollIntoView;
      else proto.scrollIntoView = original;
    }
  });
});

describe('OptionChainDialog follows the chart price', () => {
  /** Mounts the dialog with a chart price the test can move. */
  function mountWithMovingSpot(price: { value: number | null }): void {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root!: Root;
    act(() => {
      root = createRoot(container);
      root.render(
        <OptionChainDialog market="equity" symbol="AAPL" onClose={vi.fn()} spotFn={() => price.value} nowMs={() => NOW} />,
      );
    });
    mounted.push({ container, root });
  }

  it('marks the table as soon as the chart has a price, without waiting for the next reading', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(answer(chainBody()));
    vi.stubGlobal('fetch', fetch);
    const price: { value: number | null } = { value: null };
    mountWithMovingSpot(price);
    await settle();
    expect(q('[data-testid="option-chain-atm"]')).toBeNull();
    expect(text('[data-testid="option-chain-status"]')).not.toContain('Chart price');

    price.value = 101;
    await act(async () => {
      vi.advanceTimersByTime(SPOT_MS);
    });
    expect(q('[data-testid="option-chain-atm"] th')?.textContent).toBe('100');
    expect(text('[data-testid="option-chain-status"]')).toContain('Chart price 101.00');
    // The chain itself was not read again for it.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('moves the mark when the price crosses to another strike and keeps the readout current', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody())));
    const price: { value: number | null } = { value: 101 };
    mountWithMovingSpot(price);
    await settle();
    expect(q('[data-testid="option-chain-atm"] th')?.textContent).toBe('100');

    price.value = 103;
    await act(async () => {
      vi.advanceTimersByTime(SPOT_MS);
    });
    // Same band of strikes: the mark stays, the readout shows the new price.
    expect(q('[data-testid="option-chain-atm"] th')?.textContent).toBe('100');
    expect(text('[data-testid="option-chain-status"]')).toContain('Chart price 103.00');

    price.value = 108;
    await act(async () => {
      vi.advanceTimersByTime(SPOT_MS);
    });
    expect(q('[data-testid="option-chain-atm"] th')?.textContent).toBe('110');
    // 90 and 100 are below 108 (calls in the money), 110 is above (puts in the money).
    expect(document.querySelectorAll('.is-call.is-itm')).toHaveLength(10);
    expect(document.querySelectorAll('.is-put.is-itm')).toHaveLength(5);
  });
});

describe('OptionChainDialog with a publisher that states sizes and trades', () => {
  const cboe = (): Record<string, unknown> => chainBody({
    source: 'cboe',
    underlying: 'AAPL',
    underlyingPrice: 100.4,
    premiumUnit: 'USD',
    delayS: 900,
    strikes: [
      { strike: 90, call: side('C90', { bidSize: 12, askSize: 30, last: 10.5, volume: 250, openInterest: 1800 }), put: side('P90', { bidSize: null, askSize: 4, last: null, volume: 0, openInterest: 12 }) },
      { strike: 100, call: side('C100', { bidSize: 5, askSize: 6, last: 1.5, volume: 1234, openInterest: 5600 }), put: side('P100') },
      { strike: 110, call: side('C110'), put: side('P110') },
    ],
  });

  it('offers the activity view and writes sizes, the last trade, volume and open interest in it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(cboe())));
    mount();
    await settle();
    const button = q<HTMLButtonElement>('[data-testid="option-chain-mode-activity"]');
    expect(button).not.toBeNull();
    act(() => button!.click());
    expect(button!.getAttribute('aria-pressed')).toBe('true');
    expect(headerTexts()).toEqual([
      'Bid size', 'Ask size', 'Last', 'Volume', 'Open int.',
      'Open int.', 'Volume', 'Last', 'Ask size', 'Bid size',
    ]);
    const first = Array.from(rows()[0].querySelectorAll('td')).map((cell) => cell.textContent);
    expect(first.slice(0, 5)).toEqual(['12', '30', '10.50', '250', '1,800']);
    // The put side mirrors the call side; a figure the source did not state is a dash.
    expect(first.slice(5)).toEqual(['12', '0', '—', '4', '—']);
  });

  it('has no activity view for a chain that states none of it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody())));
    mount();
    await settle();
    expect(q('[data-testid="option-chain-mode-activity"]')).toBeNull();
    expect(q('[data-testid="option-chain-mode-prices"]')).not.toBeNull();
  });

  it('falls back to prices when the series it switches to has no activity', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(answer(cboe())).mockResolvedValue(answer(chainBody()));
    vi.stubGlobal('fetch', fetch);
    mount();
    await settle();
    act(() => q<HTMLButtonElement>('[data-testid="option-chain-mode-activity"]')!.click());
    act(() => q<HTMLButtonElement>('[data-testid="option-chain-refresh"]')!.click());
    await settle();
    expect(q('[data-testid="option-chain-mode-activity"]')).toBeNull();
    expect(q('[data-testid="option-chain-mode-prices"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(headerTexts().slice(0, 5)).toEqual(['Bid', 'Ask', 'Theo', 'IV', 'Delta']);
  });

  it('says how far behind the source is and names its own note', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(cboe())));
    mount();
    await settle();
    expect(text('[data-testid="option-chain-status"]')).toContain('delayed 15 min');
    expect(text('.option-chain__note')).toContain('Cboe');
    // Premiums in dollars need no remark.
    expect(text('[data-testid="option-chain-status"]')).not.toContain('premiums in');
  });

  it('names the unit when premiums are not in dollars', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody({ source: 'deribit', premiumUnit: 'BTC', delayS: 0 }))));
    mount();
    await settle();
    expect(text('[data-testid="option-chain-status"]')).toContain('premiums in BTC');
    expect(text('[data-testid="option-chain-status"]')).not.toContain('delayed');
    expect(text('.option-chain__note')).toContain('Deribit');
  });

  it('marks the table with the price the source states when the chart has none, and says so', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(cboe())));
    mount({ spot: null });
    await settle();
    expect(q('[data-testid="option-chain-atm"] th')?.textContent).toBe('100');
    expect(text('[data-testid="option-chain-status"]')).toContain('Underlying at the source 100.40');
    expect(text('[data-testid="option-chain-status"]')).not.toContain('Chart price');
  });

  it('prefers the source price when the chart is plainly not the underlying', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(cboe())));
    mount({ spot: 0.028 });
    await settle();
    expect(q('[data-testid="option-chain-atm"] th')?.textContent).toBe('100');
    expect(text('[data-testid="option-chain-status"]')).toContain('Underlying at the source 100.40');
  });

  it('keeps to the chart price when the chart is the underlying', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(cboe())));
    mount({ spot: 108 });
    await settle();
    expect(q('[data-testid="option-chain-atm"] th')?.textContent).toBe('110');
    expect(text('[data-testid="option-chain-status"]')).toContain('Chart price 108.00');
  });
});

describe('OptionChainDialog small figures and short delays', () => {
  it('writes a model price too small for the series decimals with enough decimals to be seen', async () => {
    const strikes = [{ strike: 75000, call: side('C', { bid: null, ask: 0.0001, theo: 0.00001074 }), put: null }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody({ strikes, premiumUnit: 'BTC', source: 'deribit' }))));
    mount({ spot: null });
    await settle();
    const cells = Array.from(rows()[0].querySelectorAll('td')).map((cell) => cell.textContent);
    // bid (not stated), ask to the quote's four decimals, the model price to as many as it needs.
    expect(cells.slice(0, 3)).toEqual(['—', '0.0001', '0.0000107']);
  });

  it('does not write a fraction of a coin as a size of zero', async () => {
    const strikes = [{ strike: 100, call: side('C', { bidSize: 0.004, askSize: 2.5, volume: 0, openInterest: 12.34 }), put: null }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody({ strikes }))));
    mount();
    await settle();
    act(() => q<HTMLButtonElement>('[data-testid="option-chain-mode-activity"]')!.click());
    const cells = Array.from(rows()[0].querySelectorAll('td')).map((cell) => cell.textContent);
    expect(cells[0]).toBe('0.004');
    expect(cells[1]).toBe('2.5');
    expect(cells[3]).toBe('0');
    expect(cells[4]).toBe('12.34');
  });

  it('does not announce a delay of less than a minute as zero minutes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(chainBody({ delayS: 30 }))));
    mount();
    await settle();
    expect(text('[data-testid="option-chain-status"]')).not.toContain('delayed');
  });

  it('keeps the activity view on screen while another expiry is on its way', async () => {
    const activity = [{ strike: 100, call: side('C', { volume: 12 }), put: side('P', { volume: 3 }) }];
    let release!: (response: Response) => void;
    const slow = new Promise<Response>((resolve) => { release = resolve; });
    const fetch = vi.fn().mockResolvedValueOnce(answer(chainBody({ strikes: activity }))).mockReturnValueOnce(slow);
    vi.stubGlobal('fetch', fetch);
    mount();
    await settle();
    act(() => q<HTMLButtonElement>('[data-testid="option-chain-mode-activity"]')!.click());
    const select = q<HTMLSelectElement>('[data-testid="option-chain-series"]')!;
    act(() => {
      select.value = '2026-11-20|AAPL';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    // The table waits for the new expiry; the button and its pressed state stay.
    expect(q('.option-chain__table')).toBeNull();
    expect(q('[data-testid="option-chain-mode-activity"]')?.getAttribute('aria-pressed')).toBe('true');
    release(answer(chainBody({ strikes: activity, selected: { root: 'AAPL', expiry: '2026-11-20' } })));
    await settle();
    expect(headerTexts()[0]).toBe('Bid size');
  });
});

