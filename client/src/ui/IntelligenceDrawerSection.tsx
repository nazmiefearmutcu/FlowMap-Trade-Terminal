/**
 * The shared frame of a Research section: its title, its source, and one of the
 * states a section can be in (loading, the data, or the reason it has none). The
 * reason tokens come from the server; each has a sentence in both languages, and
 * an unknown token shows a generic sentence with the token in parentheses.
 */

import type { ReactNode } from 'react';

import { useTimeZone } from '../i18n/format';
import { useT, type TFn } from '../i18n/useT';
import type { ResearchLoadState } from '../app/useResearchSection';
import type { ResearchResult, ResearchSection } from '../net/researchApi';
import { dayOrDash, instantText } from './IntelligenceDrawerFormat';

/** Reason token to its sentence key. `http_<n>` and `http_403` on GEX are handled apart. */
const REASON_KEYS: Readonly<Record<string, string>> = {
  sec_contact_missing: 'research.reason.secContactMissing',
  not_sec_registrant: 'research.reason.notSecRegistrant',
  fewer_than_two_filings: 'research.reason.fewerThanTwoFilings',
  no_earnings_release: 'research.reason.noEarningsRelease',
  unknown_company: 'research.reason.unknownCompany',
  no_awards: 'research.reason.noAwards',
  index_loading: 'research.reason.indexLoading',
  no_listed_options: 'research.reason.noListedOptions',
  no_usable_contracts: 'research.reason.noUsableContracts',
  no_spot_price: 'research.reason.noSpotPrice',
  model_failed: 'research.reason.modelFailed',
  not_in_file: 'research.reason.notInFile',
  no_public_board: 'research.reason.noPublicBoard',
  no_perpetual: 'research.reason.noPerpetual',
  no_options_market: 'research.reason.noOptionsMarket',
  not_in_top_250: 'research.reason.notInTop250',
  unreachable: 'research.reason.unreachable',
  malformed: 'research.reason.malformed',
  too_large: 'research.reason.tooLarge',
  invalid_reply: 'research.reason.invalidReply',
  failed: 'research.reason.failed',
  network: 'research.reason.network',
};

/** Every sentence key the reasons can resolve to (for the coverage tests). */
export const REASON_SENTENCE_KEYS: readonly string[] = [
  ...Object.values(REASON_KEYS),
  'research.reason.cboe403',
  'research.reason.http',
  'research.reason.unknown',
  'research.noRecord',
];

/** The sentence for a reason token, in the user's language. */
export function reasonText(t: TFn, token: string, section: ResearchSection | null): string {
  if (token === 'http_403' && section === 'gex') return t('research.reason.cboe403');
  const http = /^http_(\d{3})$/.exec(token);
  if (http) return t('research.reason.http', { status: http[1] });
  const key = REASON_KEYS[token];
  return key ? t(key) : t('research.reason.unknown', { reason: token });
}

interface ReasonLineProps {
  /** The reason token; null when the server gave none. */
  token: string | null;
  section: ResearchSection;
  onOpenSettings?: () => void;
  onRetry?: () => void;
}

/** A section's reason: the sentence, then what the reader can do about it. */
export function ReasonLine({ token, section, onOpenSettings, onRetry }: ReasonLineProps): JSX.Element {
  const t = useT();
  const text = token === null ? t('research.noRecord') : reasonText(t, token, section);
  return (
    <div className="intel-empty research-reason" data-testid="research-reason" data-reason={token ?? ''}>
      <p>{text}</p>
      {token === 'sec_contact_missing' &&
        (onOpenSettings ? (
          <button type="button" className="intel-filter-toggle" onClick={onOpenSettings} data-testid="research-open-settings">
            {t('research.openSettings')}
          </button>
        ) : (
          <p>{t('research.settingsPlace')}</p>
        ))}
      {onRetry && (
        <button type="button" className="intel-filter-toggle" onClick={onRetry} data-testid="research-retry">
          {t('research.retry')}
        </button>
      )}
    </div>
  );
}

export interface IntelSectionProps<D> {
  section: ResearchSection;
  /** The publisher's name, shown until the server's answer names it. */
  source: string;
  title: string;
  desc?: string;
  testId: string;
  state: ResearchLoadState;
  result: ResearchResult<D> | null;
  errorCode: string | null;
  onRetry: () => void;
  onOpenSettings?: () => void;
  /** The data, drawn when the answer is `ok`. */
  children: (data: D) => ReactNode;
}

export function IntelSection<D>({
  section, source, title, desc, testId, state, result, errorCode, onRetry, onOpenSettings, children,
}: IntelSectionProps<D>): JSX.Element {
  const t = useT();
  // Re-render when the time-zone preference changes, so instants follow it.
  useTimeZone();

  let body: ReactNode;
  if (result === null) {
    body = state === 'error'
      ? <ReasonLine token={errorCode ?? 'failed'} section={section} onRetry={onRetry} />
      : <p className="intel-empty">{t('research.loading')}</p>;
  } else if (result.status === 'ok' && result.data !== null) {
    body = (
      <>
        {state === 'error' && <ReasonLine token={errorCode ?? 'failed'} section={section} onRetry={onRetry} />}
        {children(result.data)}
      </>
    );
  } else if (result.status === 'unavailable') {
    body = <ReasonLine token={result.reason ?? 'failed'} section={section} onOpenSettings={onOpenSettings} onRetry={onRetry} />;
  } else {
    body = <ReasonLine token={result.reason} section={section} onOpenSettings={onOpenSettings} />;
  }

  return (
    <section className="intel-section" data-testid={testId}>
      <div className="intel-section__head">
        <span className="intel-section__tag">{result?.source ?? source}</span>
        <h3 className="intel-section__title">{title}</h3>
      </div>
      {desc && <p className="intel-section__desc">{desc}</p>}
      {body}
      {result?.stale === true && (
        <p className="intel-section__note" data-testid="research-stale">
          {t('research.stale', { time: instantText(result.fetchedAt) })}
        </p>
      )}
      {result?.asOf && (
        <p className="intel-section__note" data-testid="research-as-of">
          {t('research.asOf', { date: dayOrDash(result.asOf) })}
        </p>
      )}
    </section>
  );
}

/** A label and its value, in the drawer's key-value grid. */
export function KeyValue({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }): JSX.Element {
  return (
    <div className="research-kv__row">
      <span className="research-kv__lbl">{label}</span>
      <span className="research-kv__val">{value}</span>
      {sub !== undefined && <span className="research-kv__sub">{sub}</span>}
    </div>
  );
}
