import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

import { isTopOverlay, pushOverlay } from './overlayStack';

interface IntelDrawerFocusOptions {
  drawerRef: RefObject<HTMLElement>;
  closeRef: RefObject<HTMLButtonElement>;
  onClose: () => void;
}

/**
 * Dialog behaviour of the research drawer. It is a modal dialog: it owns Escape
 * while it is the topmost overlay, moves focus in on open, returns focus to the
 * opener on close (WCAG 2.4.3), and keeps Tab inside itself. The returned handler
 * belongs on the drawer's root `onKeyDown`.
 */
export function useIntelDrawerFocus({
  drawerRef,
  closeRef,
  onClose,
}: IntelDrawerFocusOptions): (e: ReactKeyboardEvent<HTMLElement>) => void {
  // Keep the latest onClose without re-registering the overlay on every render:
  // a re-push would move this drawer to the top of the overlay stack.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Escape closes the drawer only while it is the topmost overlay, and never a
  // keystroke another surface already consumed (see ui/overlayStack.ts).
  useEffect(() => {
    const off = pushOverlay('intel');
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (isTopOverlay('intel')) onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      off();
    };
  }, []);

  // Modal focus: move focus in on open, return it to the opener on close (WCAG 2.4.3).
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus?.();
  }, [closeRef]);

  return (e) => {
    if (e.key !== 'Tab') return;
    const aside = drawerRef.current;
    if (!aside) return;
    const focusable = aside.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !aside.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  };
}
