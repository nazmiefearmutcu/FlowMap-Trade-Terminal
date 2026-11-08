/**
 * The Settings drawer's recording switch. The desktop
 * shell owns the recorder: `recording_settings` reports whether it is on, the
 * folder and the size cap, and `set_recording_enabled` saves a new choice and
 * restarts a running engine so the change applies at once. Outside the shell
 * there is no recorder to reach, so the section says so instead of showing a
 * switch that does nothing.
 */

import { useEffect, useState } from 'react';
import { formatNumber } from '../i18n/format';
import { useT } from '../i18n/useT';
import { inDesktopShell } from '../net/sidecarStatus';

/** The shell's view of recording, as `RecordingSettings` serialises it (camelCase). */
export interface RecordingSettings {
  enabled: boolean;
  capGb: number;
  folder: string;
  /** True when the change restarted a running engine, so it applies now. */
  restarting: boolean;
}

/** Validate a shell reply; anything malformed reads as no answer (null). */
export function parseRecordingSettings(value: unknown): RecordingSettings | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.enabled !== 'boolean' || typeof v.restarting !== 'boolean') return null;
  if (typeof v.capGb !== 'number' || !Number.isFinite(v.capGb)) return null;
  if (typeof v.folder !== 'string') return null;
  return { enabled: v.enabled, capGb: v.capGb, folder: v.folder, restarting: v.restarting };
}

interface ShellBridge {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

/** Plain IPC to a shell command. Rejects outside the shell, so callers never guess. */
function shellInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const bridge = (window as unknown as { __TAURI_INTERNALS__?: Partial<ShellBridge> }).__TAURI_INTERNALS__;
  if (!bridge || typeof bridge.invoke !== 'function') return Promise.reject(new Error('no desktop shell'));
  return bridge.invoke(cmd, args);
}

type Phase = 'loading' | 'ready' | 'saving' | 'failed';
/** What the last change did: applied now, saved for the next launch, or refused. */
type Outcome = 'restarted' | 'nextLaunch' | 'failed' | null;

export function RecordingSection(): JSX.Element {
  const t = useT();
  const [shell] = useState(() => inDesktopShell());
  const [settings, setSettings] = useState<RecordingSettings | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [outcome, setOutcome] = useState<Outcome>(null);

  useEffect(() => {
    if (!shell) return;
    let live = true;
    shellInvoke('recording_settings')
      .then((value) => {
        if (!live) return;
        const loaded = parseRecordingSettings(value);
        setSettings(loaded);
        setPhase(loaded ? 'ready' : 'failed');
      })
      .catch(() => {
        if (live) setPhase('failed');
      });
    return () => {
      live = false;
    };
  }, [shell]);

  if (!shell) {
    return (
      <div className="setting">
        <span className="setting__label">{t('settings.recording')}</span>
        <span className="setting__hint" data-testid="setting-recording-unavailable">
          {t('settings.recordingDesktopOnly')}
        </span>
      </div>
    );
  }

  const toggle = (): void => {
    if (!settings || phase !== 'ready') return;
    setPhase('saving');
    setOutcome(null);
    shellInvoke('set_recording_enabled', { enabled: !settings.enabled })
      .then((value) => {
        const saved = parseRecordingSettings(value);
        if (!saved) throw new Error('unreadable reply');
        setSettings(saved);
        setOutcome(saved.restarting ? 'restarted' : 'nextLaunch');
        setPhase('ready');
      })
      .catch(() => {
        setOutcome('failed');
        setPhase('ready');
      });
  };

  const status =
    phase === 'loading' ? t('settings.recordingLoading')
      : phase === 'failed' ? t('settings.recordingUnreadable')
        : phase === 'saving' ? t('settings.recordingSaving')
          : outcome === 'restarted' ? t('settings.recordingRestarted')
            : outcome === 'nextLaunch' ? t('settings.recordingNextLaunch')
              : outcome === 'failed' ? t('settings.recordingFailed')
                : '';

  return (
    <div className="setting">
      <button
        type="button"
        role="switch"
        aria-checked={settings?.enabled ?? false}
        className={`check${settings?.enabled ? ' is-on' : ''}`}
        data-testid="toggle-recording"
        disabled={phase !== 'ready' || settings === null}
        onClick={toggle}
      >
        {t('settings.recording')}
        <span className="check__box" aria-hidden="true" />
      </button>
      <span className="setting__hint">{t('settings.recordingHint')}</span>
      {settings && (
        <>
          <span className="setting__hint" data-testid="setting-recording-cap">
            {t('settings.recordingCap', { gb: formatNumber(settings.capGb) })}
          </span>
          <span className="setting__hint" data-testid="setting-recording-folder">
            {t('settings.recordingFolder', { folder: settings.folder })}
          </span>
        </>
      )}
      <span className="setting__hint" role="status" aria-live="polite" data-testid="setting-recording-state">
        {status}
      </span>
    </div>
  );
}
