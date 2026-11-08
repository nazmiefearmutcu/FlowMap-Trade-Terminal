import type { Dispatch, SetStateAction } from 'react';

import { useT } from '../i18n/useT';
import type { DeskPreferences } from '../ui/deskPreferences';
import { DomLadder } from '../ui/DomLadder';
import { OrderFlowPanel } from '../ui/OrderFlowPanel';
import { PaneResizer } from '../ui/PaneResizer';
import { Tape } from '../ui/Tape';
import { Watchlist } from '../ui/Watchlist';

interface RightRailProps {
  desk: DeskPreferences;
  setDesk: Dispatch<SetStateAction<DeskPreferences>>;
  bigTradeUsd: number;
  /** `market:symbol` of the chart on screen, highlighted in the watchlist. */
  activeKey: string;
  onSelectSymbol: (market: string, symbol: string) => void;
}

/**
 * The collapsible right rail: watchlist, order-flow panel, then the DOM ladder
 * and the tape. Its splitters resize the rail and the ladder/tape split.
 */
export function RightRail({ desk, setDesk, bigTradeUsd, activeKey, onSelectSymbol }: RightRailProps): JSX.Element {
  const t = useT();
  return (
    <>
      <PaneResizer axis="x" variable="--desk-rail-width" value={desk.railWidth} min={280} max={560}
        label={t('desk.resizeRail')} onCommit={railWidth => setDesk(prev => ({ ...prev, railWidth }))} />
      <aside className="right-rail" data-testid="right-rail">
        <Watchlist
          activeKey={activeKey}
          onSelect={(key) => {
            const i = key.indexOf(':');
            if (i > 0) onSelectSymbol(key.slice(0, i), key.slice(i + 1));
          }}
        />
        <OrderFlowPanel />
        <div className="desk-book-panels">
          <DomLadder />
          <PaneResizer axis="y" variable="--desk-dom-ratio" value={desk.domRatio} min={.25} max={.75} ratio
            label={t('desk.resizeBookTape')} onCommit={domRatio => setDesk(prev => ({ ...prev, domRatio }))} />
          <Tape bigTradeUsd={bigTradeUsd} />
        </div>
      </aside>
    </>
  );
}
