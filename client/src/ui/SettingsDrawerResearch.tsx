/**
 * The SEC contact e-mail, in Settings → Data. SEC's fair-access rule asks
 * automated programs to name a contact; the Research sections on the server use
 * this address in their request to sec.gov and nowhere else.
 *
 * The text is committed on blur or Enter. An entry that is not an e-mail shape is
 * not committed: the field says so and keeps the text for correction. An empty
 * entry clears the contact.
 */

import { useEffect, useState } from 'react';

import { useT } from '../i18n/useT';
import { isValidSecContact, type FlowMapSettings } from './settings';

interface ResearchContactSectionProps {
  /** The stored contact ('' when not set). */
  secContact: string;
  onChange: (patch: Partial<FlowMapSettings>) => void;
}

export function ResearchContactSection({ secContact, onChange }: ResearchContactSectionProps): JSX.Element {
  const t = useT();
  const [draft, setDraft] = useState(secContact);
  const [invalid, setInvalid] = useState(false);

  // A value changed elsewhere (restore defaults, a reload) replaces the field's text.
  useEffect(() => {
    setDraft(secContact);
    setInvalid(false);
  }, [secContact]);

  const commit = (): void => {
    const value = draft.trim();
    if (value !== '' && !isValidSecContact(value)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(value);
    if (value !== secContact) onChange({ secContact: value });
  };

  return (
    <div className="setting">
      <label className="setting__label" htmlFor="setting-secContact-input">
        {t('settings.secContact.label')}
      </label>
      <input
        id="setting-secContact-input"
        type="email"
        className="setting__text"
        autoComplete="email"
        value={draft}
        aria-invalid={invalid}
        data-testid="setting-secContact"
        onChange={(e) => {
          setDraft(e.target.value);
          setInvalid(false);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
      {invalid ? (
        <span className="setting__hint" role="alert" data-testid="setting-secContact-invalid">
          {t('settings.secContact.invalid')}
        </span>
      ) : null}
      <span className="setting__hint">{t('settings.secContact.hint')}</span>
    </div>
  );
}
