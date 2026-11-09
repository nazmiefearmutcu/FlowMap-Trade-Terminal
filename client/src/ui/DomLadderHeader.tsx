/**
 * The DOM ladder's header: the collapse toggle, the honesty badge, the provenance
 * chip, the spread and resolution readouts, and the follow / centre controls.
 * Every value is formatted by the parent, so this stays a presentational piece.
 */

import { useT } from '../i18n/useT';

export interface LadderSpreadReadout {
  /** The spread already formatted at the ladder's precision. */
  price: string;
  /** True when the spread is derived from the book, not from a live BBO. */
  approximate: boolean;
  /** Spread in whole ticks (shown only when positive). */
  ticks: number;
}

export interface LadderHeaderProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  badge: string;
  badgeClass: string;
  recorded: boolean;
  spread: LadderSpreadReadout | null;
  /** The formatted price step at the mid, or null when there is no mid yet. */
  resolution: string | null;
  locked: boolean;
  midAvailable: boolean;
  onToggleLock: () => void;
  onCenter: () => void;
}

export function LadderHeader({
  collapsed,
  onToggleCollapsed,
  badge,
  badgeClass,
  recorded,
  spread,
  resolution,
  locked,
  midAvailable,
  onToggleLock,
  onCenter,
}: LadderHeaderProps) {
  const t = useT();
  return (
    <header className="panel__header">
      <h2 className="panel__heading">
        <button
          type="button"
          className="panel__collapse"
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
          data-testid="ladder-collapse"
        >
          <span className="panel__chevron">{collapsed ? '▸' : '▾'}</span>
          <span className="panel__title">{t('ladder.title')}</span>
        </button>
      </h2>
      <span
        className={`panel__badge panel__badge--${badgeClass}`}
        data-testid="ladder-badge"
      >
        {badge}
      </span>
      {recorded && (
        <span
          className="panel__badge panel__badge--recorded-density"
          data-testid="ladder-provenance"
          title={t('ladder.recordedTitle')}
        >
          {t('chip.recordedDensity')}
        </span>
      )}
      {spread && (
        <span className="panel__spread" data-testid="ladder-spread">
          {t('ladder.spreadShort')} {spread.approximate ? '≈' : ''}{spread.price}
          {spread.ticks > 0 ? ` (${spread.ticks}t)` : ''}
        </span>
      )}
      {resolution !== null && (
        <span className="panel__resolution" data-testid="ladder-resolution"
          title={t('ladder.resolutionTitle')}>
          Δ {resolution}
        </span>
      )}
      <button
        type="button"
        className={`panel__lock${locked ? ' is-on' : ''}`}
        disabled={!midAvailable}
        title={locked ? t('ladder.lockedTitle') : t('ladder.followTitle')}
        onClick={onToggleLock}
        data-testid="ladder-lock"
      >
        {locked ? t('ladder.locked') : t('ladder.follow')}
      </button>
      <button type="button" className="panel__lock ladder__center" data-testid="ladder-center"
        disabled={!midAvailable}
        title={t('ladder.centerTitle')}
        onClick={onCenter}>{t('ladder.center')}</button>
    </header>
  );
}
