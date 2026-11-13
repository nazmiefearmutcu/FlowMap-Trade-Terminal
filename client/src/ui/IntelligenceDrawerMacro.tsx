import { formatDateTime, formatFixed } from '../i18n/format';
import { useT } from '../i18n/useT';
import { DEMO_INTELLIGENCE, type MacroStressData } from '../state/intelligenceStore';
import { macroHyNote } from './TopBarParts';
import { stressRegimeLabel } from './TopBarLabels';

interface IntelMacroBarProps {
  macro: MacroStressData | null;
  /** The SIM-DEMO fixture is on screen. The label shows only when the fixture is the reading shown. */
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
  const curve = macro?.yieldCurve10Y2Y ?? null;
  const showingFixture = demo && macro === DEMO_INTELLIGENCE.macro;
  // With a reading but no regime (the high-yield spread is missing), the regime is a dash, not UNAVAILABLE.
  const regimeKnown = macro !== null && macro.stressRegime !== 'UNKNOWN';
  const regimeText = macro === null
    ? t('intel.macroNotConnected')
    : regimeKnown
      ? t('intel.stressRegime', { regime: stressRegimeLabel(macro.stressRegime, t) })
      : '—';
  return (
    <div className="intel-drawer__macro-bar" data-testid="intel-macro-bar">
      <div className="macro-chip">
        <span className="macro-chip__lbl">SOFR</span>
        <span className="macro-chip__val">{macro?.sofrRate != null ? `${formatFixed(macro.sofrRate, 2)}%` : '—'}</span>
      </div>
      <div className="macro-chip">
        <span className="macro-chip__lbl">{t('intel.macro.hy')}</span>
        <span className="macro-chip__val">
          {macro?.hySpreadBps != null ? `${formatFixed(macro.hySpreadBps, 0)} ${t('unit.bps')}` : '—'}
        </span>
        {macro !== null && macro.hySpreadBps === null && (
          <span className="macro-chip__lbl" data-testid="intel-macro-hy-note">{macroHyNote(macro, t)}</span>
        )}
      </div>
      <div className="macro-chip">
        <span className="macro-chip__lbl">{t('intel.macro.curve')}</span>
        <span className={`macro-chip__val ${curve !== null ? (curve < 0 ? 'is-neg' : 'is-pos') : ''}`}>
          {curve !== null ? `${curve < 0 ? '' : '+'}${formatFixed(curve, 2)}% ${curve < 0 ? t('intel.inverted') : ''}` : '—'}
        </span>
      </div>
      <div
        className={`macro-regime-badge is-${macro?.stressRegime.toLowerCase() ?? 'unavailable'}`}
        title={macro ? undefined : t('intel.macroNotConnected')}
      >
        {showingFixture ? `${t('intel.demoBadge')} · ` : ''}
        {regimeText}
      </div>
      {macro !== null && macro.stressRegime === 'UNKNOWN' && macro.hySpreadBps === null && (
        <span className="macro-chip__lbl" data-testid="intel-macro-regime-note">{macroHyNote(macro, t)}</span>
      )}
      {macro && (
        <span className="macro-chip__lbl" data-testid="intel-macro-received">
          {t('intel.received', { time: receivedAt })}
        </span>
      )}
      {macro?.stale === true && (
        <span className="macro-chip__lbl" data-testid="intel-macro-stale">{t('macro.stale')}</span>
      )}
    </div>
  );
}
