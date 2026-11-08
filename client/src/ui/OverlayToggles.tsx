/**
 * Overlay visibility toggles: which overlays are on.
 *
 * A compact button row in the top bar. Default all on except the volume profile
 * (a denser, opt-in overlay). Each click flips one overlay via the renderer's
 * imperative `setOverlayVisibility` — this is UI state, not per-frame data, so it
 * lives in React.
 */

import type { OverlayVisibility } from '../gl/overlays/frame';
import { useT } from '../i18n/useT';

// Labels and hints are translated per key (overlay.<key>.label / .hint).
const ITEMS: ReadonlyArray<keyof OverlayVisibility> = [
  'price', 'bubbles', 'volume', 'bbo', 'vwap', 'cvd', 'profile', 'gex', 'markers', 'axes',
];

interface OverlayTogglesProps {
  visibility: OverlayVisibility;
  onToggle: (key: keyof OverlayVisibility) => void;
}

export function OverlayToggles({ visibility, onToggle }: OverlayTogglesProps): JSX.Element {
  const t = useT();
  return (
    <div className="overlay-toggles" role="group" aria-label={t('overlay.group')}>
      {ITEMS.map((key) => {
        const description = t(`overlay.${key}.hint`);
        return (
          <button
            key={key}
            type="button"
            className={`overlay-toggle${visibility[key] ? ' is-on' : ''}`}
            aria-pressed={visibility[key]}
            aria-label={description}
            title={description}
            onClick={() => onToggle(key)}
          >
            {t(`overlay.${key}.label`)}
          </button>
        );
      })}
    </div>
  );
}
