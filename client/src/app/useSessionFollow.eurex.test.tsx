import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { Renderer } from '../gl/renderer';
import { useFlowMapStore } from '../state/store';
import { useSessionResetBridge } from './useSessionFollow';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('clears the native GPU/ring on same-session snapshot Hello, including empty replacement', () => {
  const resetForSession = vi.fn();
  const renderer = { resetForSession, setFollowTime: vi.fn(), setPriceFollow: vi.fn() } as unknown as Renderer;
  function Harness() {
    const ref = useRef(renderer);
    const follow = useRef({ time: true, price: 'fit' as const });
    useSessionResetBridge(ref, follow, vi.fn());
    return null;
  }
  useFlowMapStore.setState({ sessionId: 'same', attachEpoch: 1,
    capability: { native_candles: true }, subscription: { market: 'futures-eurex-official', symbol: 'FDAXZ2026', mode: 'live', band: 'native' } });
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Harness />));
  act(() => useFlowMapStore.setState({ attachEpoch: 2 }));
  expect(resetForSession).toHaveBeenCalledOnce();
  act(() => useFlowMapStore.setState({ attachEpoch: 3 }));
  expect(resetForSession).toHaveBeenCalledTimes(2);
  act(() => root.unmount());
});

it('keeps the camera on a native snapshot of the same chart and re-applies follow only on a new chart', () => {
  const setFollowTime = vi.fn();
  const setPriceFollow = vi.fn();
  const resetForSession = vi.fn();
  const renderer = {
    resetForSession, setFollowTime, setPriceFollow, wantedFollowTime: true, priceFollow: 'fit',
  } as unknown as Renderer;
  function Harness() {
    const ref = useRef(renderer);
    const follow = useRef({ time: true, price: 'fit' as const });
    useSessionResetBridge(ref, follow, vi.fn());
    return null;
  }
  const dax = { market: 'futures-eurex-official', symbol: 'FDAXZ2026', mode: 'live' as const, band: 'native' };
  useFlowMapStore.setState({ sessionId: 'same', attachEpoch: 10, capability: { native_candles: true }, subscription: dax });
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Harness />));
  // New published minutes: the columns are replaced, the camera is left where the user put it.
  act(() => useFlowMapStore.setState({ attachEpoch: 11 }));
  act(() => useFlowMapStore.setState({ attachEpoch: 12 }));
  expect(resetForSession).toHaveBeenCalledTimes(2);
  expect(setFollowTime).not.toHaveBeenCalled();
  expect(setPriceFollow).not.toHaveBeenCalled();
  // Another chart is a new identity: the follow policy applies as for any symbol switch.
  act(() => useFlowMapStore.setState({ subscription: { ...dax, symbol: 'FGBLZ2026' }, attachEpoch: 13 }));
  expect(setFollowTime).toHaveBeenCalledOnce();
  expect(setPriceFollow).toHaveBeenCalledOnce();
  act(() => root.unmount());
});

