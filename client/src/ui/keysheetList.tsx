/**
 * The keyboard reference rows, rendered by the `?` overlay (ui/ShortcutsOverlay)
 * from the shared {@link KEYSHEET}. With the single-key switch off (WCAG 2.1.4),
 * a row whose keys are bare characters stays listed for reference but is marked
 * off, because its key does nothing until the switch is back on.
 */

import { useT } from '../i18n/useT';
import { KEYSHEET, type KeysheetEntry } from './keysheet';
import { isBareKeyRow } from './SettingsDrawerKeys';

/** Key names that Turkish reads differently. Every other key label is the same in both locales. */
const KEY_CAP_KEYS: ReadonlyMap<string, string> = new Map([
  ['Space', 'keysheet.keyCap.space'],
  ['Del', 'keysheet.keyCap.delete'],
  ['axis wheel / drag', 'keysheet.keyCap.axisDrag'],
]);

/** The i18n key of a localised key label, or null when the key name reads the same in every locale. */
export function keyCapKey(keys: KeysheetEntry['keys']): string | null {
  return KEY_CAP_KEYS.get(keys) ?? null;
}

interface KeysheetRowsProps {
  /** The single-key switch state: true while bare-character shortcuts work. */
  singleKeys: boolean;
}

export function KeysheetRows({ singleKeys }: KeysheetRowsProps): JSX.Element {
  const t = useT();
  return (
    <>
      {KEYSHEET.map((entry) => {
        const off = !singleKeys && isBareKeyRow(entry.keys);
        const capKey = keyCapKey(entry.keys);
        return (
          <div
            key={entry.keys}
            className={off ? 'keysheet__row is-off' : 'keysheet__row'}
            data-testid={off ? 'keysheet-row-off' : undefined}
          >
            <kbd className="keysheet__keys">{capKey ? t(capKey) : entry.keys}</kbd>
            <span className="keysheet__action">
              {t(entry.actionKey)}
              {off && <span className="keysheet__off"> ({t('shortcuts.keyOff')})</span>}
            </span>
          </div>
        );
      })}
    </>
  );
}
