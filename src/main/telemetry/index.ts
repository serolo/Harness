import { randomUUID } from 'node:crypto';
import { app, crashReporter } from 'electron';
import { PostHog } from 'posthog-node';
import * as Sentry from '@sentry/electron/main';

import type {
  TelemetryConsent,
  TelemetryConsentUpdate,
} from '@shared/telemetry';
import {
  publicConsent,
  readTelemetryPrivacy,
  readTelemetryPrivacySync,
  updateTelemetryPrivacy,
  type StoredTelemetryPrivacy,
} from './privacy';
import {
  allowlistedProperties,
  filterSentryBreadcrumb,
  scrubSentryEvent,
  type TelemetryEvent,
  type TelemetryProperties,
} from './policy';

export type { TelemetryEvent, TelemetryProperties } from './policy';

declare const __HARNESS_POSTHOG_TOKEN__: string;
declare const __HARNESS_POSTHOG_HOST__: string;
declare const __HARNESS_SENTRY_DSN__: string;

const posthogToken =
  typeof __HARNESS_POSTHOG_TOKEN__ === 'string'
    ? __HARNESS_POSTHOG_TOKEN__
    : '';
const posthogHost =
  typeof __HARNESS_POSTHOG_HOST__ === 'string'
    ? __HARNESS_POSTHOG_HOST__
    : 'https://us.i.posthog.com';
const sentryDsn =
  typeof __HARNESS_SENTRY_DSN__ === 'string' ? __HARNESS_SENTRY_DSN__ : '';

let sentryActive = false;

/** Must run before `app.whenReady()` so Electron native crash capture can attach. */
export function bootstrapCrashReporting(): boolean {
  const privacy = readTelemetryPrivacySync();
  if (!privacy.crashReporting || sentryDsn === '') return false;
  Sentry.init({
    dsn: sentryDsn,
    release: app.getVersion(),
    environment: app.isPackaged ? 'production' : 'development',
    sendDefaultPii: false,
    sendClientReports: false,
    attachScreenshot: false,
    tracesSampleRate: 0,
    beforeSend: scrubSentryEvent,
    beforeBreadcrumb: filterSentryBreadcrumb,
    initialScope: {
      tags: {
        app_version: app.getVersion(),
        os: process.platform,
        arch: process.arch,
        process_type: 'main',
      },
    },
  });
  sentryActive = true;
  return true;
}

export class TelemetryService {
  private privacy: StoredTelemetryPrivacy;
  private posthog: PostHog | undefined;
  private readonly sessionId = randomUUID();
  private consentUpdate: Promise<void> = Promise.resolve();

  private constructor(privacy: StoredTelemetryPrivacy) {
    this.privacy = privacy;
    this.configurePostHog();
  }

  static async create(): Promise<TelemetryService> {
    return new TelemetryService(await readTelemetryPrivacy());
  }

  getConsent(): TelemetryConsent {
    return publicConsent(this.privacy, sentryActive);
  }

  setConsent(update: TelemetryConsentUpdate): Promise<TelemetryConsent> {
    const result = this.consentUpdate.then(() => this.applyConsent(update));
    this.consentUpdate = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async applyConsent(
    update: TelemetryConsentUpdate,
  ): Promise<TelemetryConsent> {
    const wasUsageEnabled = this.privacy.usageAnalytics;
    this.privacy = await updateTelemetryPrivacy(this.privacy, update);
    if (wasUsageEnabled && !this.privacy.usageAnalytics) {
      const client = this.posthog;
      this.posthog = undefined;
      if (client) {
        await client.disable();
        // `shutdown()` normally flushes. Consent withdrawal must discard instead, so
        // clear the SDK's in-memory queue after opting out and only then stop timers.
        client.setPersistedProperty(
          'queue' as Parameters<PostHog['setPersistedProperty']>[0],
          [],
        );
        await client.shutdown();
      }
    } else if (!wasUsageEnabled && this.privacy.usageAnalytics) {
      this.configurePostHog();
    }

    if (!this.privacy.crashReporting && sentryActive) {
      try {
        crashReporter.setUploadToServer(false);
      } catch {
        // Some Linux builds do not expose upload toggling; closing Sentry below still
        // disables its transport for the current process.
      }
      await Sentry.close(2_000);
      sentryActive = false;
    }
    return this.getConsent();
  }

  capture(event: TelemetryEvent, properties: TelemetryProperties = {}): void {
    if (!this.posthog || !this.privacy.posthogDistinctId) return;
    this.posthog.capture({
      distinctId: this.privacy.posthogDistinctId,
      event,
      properties: {
        ...allowlistedProperties(event, properties),
        app_version: app.getVersion(),
        os: process.platform,
        arch: process.arch,
        $session_id: this.sessionId,
        $is_server: false,
        $process_person_profile: false,
      },
    });
  }

  captureException(error: unknown, category: string): void {
    if (!sentryActive) return;
    Sentry.withScope((scope) => {
      scope.setTag('error_category', category);
      Sentry.captureException(error);
    });
  }

  async shutdown(): Promise<void> {
    const client = this.posthog;
    this.posthog = undefined;
    await Promise.allSettled([
      client?.shutdown(),
      sentryActive ? Sentry.flush(2_000) : undefined,
    ]);
  }

  private configurePostHog(): void {
    if (
      !this.privacy.usageAnalytics ||
      !this.privacy.posthogDistinctId ||
      posthogToken === ''
    ) {
      return;
    }
    this.posthog = new PostHog(posthogToken, {
      host: posthogHost,
      disableGeoip: true,
      flushAt: 20,
      flushInterval: 10_000,
      enableExceptionAutocapture: false,
    });
  }
}
