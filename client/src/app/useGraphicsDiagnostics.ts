import { useCallback, useState } from 'react';

import { useFlowMapStore } from '../state/store';
import { copyChartDiagnostics, type CopyState } from '../ui/ChartStartupGate';

export interface GraphicsDiagnostics {
  copyState: CopyState;
  copyDiagnostics: () => void;
}

/**
 * The graphics fallback's "Copy diagnostics" action. It writes the same plain-text
 * report the chart gate copies, so both fallbacks give an identical bug report.
 * A refused copy is reported to the user, never swallowed.
 */
export function useGraphicsDiagnostics(failure: string | null): GraphicsDiagnostics {
  const [copyState, setCopyState] = useState<CopyState>('idle');

  const copyDiagnostics = useCallback(() => {
    const sub = useFlowMapStore.getState().subscription;
    void copyChartDiagnostics({
      failure: failure ?? 'none',
      instrument: sub ? `${sub.market}:${sub.symbol}` : null,
    }).then(
      () => setCopyState('copied'),
      () => setCopyState('failed'),
    );
  }, [failure]);

  return { copyState, copyDiagnostics };
}
