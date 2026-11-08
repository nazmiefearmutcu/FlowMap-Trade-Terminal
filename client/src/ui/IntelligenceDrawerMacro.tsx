import { formatDateTime, formatFixed } from '../i18n/format';
import { useT } from '../i18n/useT';
import type { MacroStressData } from '../state/intelligenceStore';

interface IntelMacroBarProps {
  macro: MacroStressData | null;
  /** The SIM-DEMO fixture is on screen, so the regime badge says so. */
  demo: boolean;
}

/**
 * The macro liquidity footer of the research drawer: SOFR, the high-yield spread,
 * the 10Y-2Y curve and the heuristic stress regime, with when the figures arrived.
 */
export function IntelMacroBar({ macro, demo }: IntelMacroBarProps): JSX.Element {
  const t = useT();
  const receivedAt = macro
    ? formatDateTime(macro.updatedAt, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    : '';
  return (
    <div className="intel-drawer__macro-bar" data-testid="intel-macro-bar">
      <div className="macro-chip">
        <span className="macro-chip__lbl">SOFR</span>
        <span className="macro-chip__val">{macro ? `${formatFixed(macro.sofrRate, 2)}%` : '—'}</span>
      </div>
      <div className="macro-chip">
        <span className="macro-chip__lbl">{t('intel.macro.hy')}</span>
        <span className="macro-chip__val">{macro ? `${formatFixed(macro.hySpreadBps, 0)} ${t('unit.bps')}` : '—'}</span>
      </div>
      <div className="macro-chip">
        <span className="macro-chip__lbl">{t('intel.macro.curve')}</span>
        <span className={`macro-chip__val ${macro ? (macro.yieldCurve10Y2Y < 0 ? 'is-neg' : 'is-pos') : ''}`}>
          {macro ? `${macro.yieldCurve10Y2Y < 0 ? '' : '+'}${formatFixed(macro.yieldCurve10Y2Y, 2)}% ${macro.yieldCurve10Y2Y < 0 ? t('intel.inverted') : ''}` : '—'}
        </span>
      </div>
      <div
        className={`macro-regime-badge is-${macro?.stressRegime.toLowerCase() ?? 'unavailable'}`}
        title={macro ? macro.status : t('intel.macroNotConnected')}
      >
        {demo ? `${t('intel.demoBadge')} · ` : ''}
        {macro ? t('intel.stressRegime', { regime: macro.stressRegime }) : t('intel.macroNotConnected')}
      </div>
      {macro && (
        <span className="macro-chip__lbl" data-testid="intel-macro-received">
          {t('intel.received', { time: receivedAt })}
        </span>
      )}
    </div>
  );
}
