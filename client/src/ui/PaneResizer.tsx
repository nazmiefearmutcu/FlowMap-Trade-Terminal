import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

import { formatNumber } from '../i18n/format';
import { useT } from '../i18n/useT';

interface PaneResizerProps {
  /** `x` splits a column (vertical separator); `y` splits a stack (horizontal separator). */
  axis: 'x' | 'y';
  /** Current size: pixels, or a share of the parent height when `ratio` is set. */
  value: number;
  min: number;
  max: number;
  /** The CSS custom property this splitter drives on the desk root. */
  variable: string;
  /** Accessible name of the separator. */
  label: string;
  onCommit: (value: number) => void;
  ratio?: boolean;
}

interface Drag {
  start: number;
  value: number;
  latest: number;
  root: HTMLElement;
  scale: number;
}

/**
 * A draggable splitter. A drag changes the CSS variable live, and the value is
 * committed (and persisted by the caller) only when the gesture ends. Arrow keys
 * step the value, and a double-click restores the midpoint of the range.
 */
export function PaneResizer({
  axis, value, min, max, variable, label, onCommit, ratio = false,
}: PaneResizerProps): JSX.Element {
  const t = useT();
  const drag = useRef<Drag | null>(null);
  // Screen readers announce the size in words: a share for a ratio splitter,
  // a whole pixel count otherwise, both in the active locale.
  const valueText = ratio
    ? formatNumber(value, { style: 'percent', maximumFractionDigits: 0 })
    : `${formatNumber(Math.round(value))} ${t('unit.px')}`;

  const paint = (root: HTMLElement, n: number): void => {
    root.style.setProperty(variable, ratio ? String(n) : `${n}px`);
  };

  const begin = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    const root = e.currentTarget.closest<HTMLElement>('[data-desk-root]');
    if (!root) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      start: axis === 'x' ? e.clientX : e.clientY,
      value,
      latest: value,
      root,
      // Pixel splitters measure the pane on the far side of the separator, so the
      // pointer delta is negated (scale -1). A ratio is measured against the parent.
      scale: ratio ? Math.max(1, e.currentTarget.parentElement?.clientHeight ?? 1) : -1,
    };
  };

  const move = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    const diff = (axis === 'x' ? e.clientX : e.clientY) - d.start;
    d.latest = Math.max(min, Math.min(max, d.value + diff / d.scale));
    paint(d.root, d.latest);
  };

  const finish = (cancel: boolean): void => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (cancel) paint(d.root, value);
    else onCommit(d.latest);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowUp' && e.key !== 'ArrowRight' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    e.stopPropagation();
    const step = ratio ? 0.05 : 16;
    // Same direction as the pointer path: a ratio grows toward the drag, while a
    // pixel pane (right rail, CVD) grows when the separator moves left or up.
    const dir = ratio ? 1 : -1;
    const signed = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -step : step;
    onCommit(Math.max(min, Math.min(max, value + signed * dir)));
  };

  return (
    <div
      className={`pane-resizer pane-resizer--${axis}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={() => finish(false)}
      onPointerCancel={() => finish(true)}
      onLostPointerCapture={() => finish(false)}
      onDoubleClick={() => onCommit((min + max) / 2)}
      onKeyDown={onKeyDown}
    />
  );
}
