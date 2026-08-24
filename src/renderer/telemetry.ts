import { invoke } from '@renderer/ipc';

let rendererCrashReportingInitialized = false;

/** Initialize the official renderer integration only when main confirms it is active. */
export async function initializeRendererCrashReporting(): Promise<void> {
  if (rendererCrashReportingInitialized) return;
  const consent = await invoke('privacy:getTelemetryConsent', undefined);
  if (!consent.crashReportingActive) return;
  const Sentry = await import('@sentry/electron/renderer');
  Sentry.init({
    sendDefaultPii: false,
    autoSessionTracking: false,
    sendClientReports: false,
    tracesSampleRate: 0,
    beforeBreadcrumb: () => null,
    beforeSend: (event) => ({
      type: event.type,
      event_id: event.event_id,
      timestamp: event.timestamp,
      platform: event.platform,
      level: event.level,
      release: event.release,
      environment: event.environment,
      exception: event.exception,
    }),
  });
  rendererCrashReportingInitialized = true;
}
