import { useEffect, useState } from 'react';

import type { TelemetryConsent } from '@shared/telemetry';
import { Switch } from '@renderer/components/ui';
import { invoke } from '@renderer/ipc';

export function TelemetryConsentControls(): React.JSX.Element {
  const [consent, setConsent] = useState<TelemetryConsent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void invoke('privacy:getTelemetryConsent', undefined)
      .then((value) => {
        if (active) setConsent(value);
      })
      .catch((reason: unknown) => {
        if (active)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, []);

  const update = async (
    field: 'usageAnalytics' | 'crashReporting',
    enabled: boolean,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setConsent(
        await invoke('privacy:setTelemetryConsent', { [field]: enabled }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (consent === null) {
    return (
      <p className="text-sm text-fg-3" data-testid="telemetry-consent-loading">
        Loading privacy choices…
      </p>
    );
  }

  return (
    <div className="space-y-5" data-testid="telemetry-consent-controls">
      <ConsentRow
        title="Share anonymous usage analytics"
        description="Sends feature events, app version, operating system, and anonymous timing/count data. Never sends repository names, paths, prompts, chat, diffs, commands, or terminal output."
        checked={consent.usageAnalytics}
        disabled={busy}
        testId="telemetry-usage-toggle"
        onChange={(enabled) => void update('usageAnalytics', enabled)}
      />
      <ConsentRow
        title="Send crash and error reports"
        description="Sends sanitized stack traces and native crash diagnostics to Sentry. Native crash dumps can contain diagnostic process data. No account or analytics identifier is attached."
        checked={consent.crashReporting}
        disabled={busy}
        testId="telemetry-crash-toggle"
        onChange={(enabled) => void update('crashReporting', enabled)}
      />
      {consent.crashReporting && !consent.crashReportingActive ? (
        <p className="rounded-2 border border-warn bg-warn-muted px-3 py-2 text-xs text-warn">
          Native crash reporting starts after the next app launch.
        </p>
      ) : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}

function ConsentRow({
  title,
  description,
  checked,
  disabled,
  testId,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  testId: string;
  onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-8 rounded-2 border border-border-1 bg-surface-well px-4 py-4">
      <div>
        <div className="text-sm font-semibold text-fg-1">{title}</div>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-fg-3">
          {description}
        </p>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        aria-label={title}
        data-testid={testId}
      />
    </div>
  );
}
