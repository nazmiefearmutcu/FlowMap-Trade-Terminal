import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

import { classifyTarget } from '../input/keys';
import { isSingleKeyShortcutsEnabled } from '../input/shortcutPrefs';
import { isHelpToggle } from '../ui/keysheet';

/**
 * The `?` toggle for the shortcuts overlay. Handled OUTSIDE attachGlobalKeys
 * (input/keys does not route `?`), but with the same focus-safety rules via the
 * shared isHelpToggle: it never fires while typing (a typed `?` is a search
 * character), never while a dialog owns the keyboard (the overlay closes itself
 * with Escape), and honours the single-key preference.
 */
export function useHelpToggle(): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!isSingleKeyShortcutsEnabled()) return;
      if (!isHelpToggle(e.key, classifyTarget(e.target))) return;
      e.preventDefault();
      setHelpOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return [helpOpen, setHelpOpen];
}
