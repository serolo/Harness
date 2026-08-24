import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';

import type {
  TelemetryConsent,
  TelemetryConsentUpdate,
} from '@shared/telemetry';
import { telemetryPrivacyPath } from '../paths';

const PRIVACY_VERSION = 1;

export interface StoredTelemetryPrivacy {
  version: 1;
  usageAnalytics: boolean;
  crashReporting: boolean;
  posthogDistinctId?: string;
}

const DEFAULT_PRIVACY: StoredTelemetryPrivacy = {
  version: PRIVACY_VERSION,
  usageAnalytics: false,
  crashReporting: false,
};

function parsePrivacy(value: unknown): StoredTelemetryPrivacy {
  if (typeof value !== 'object' || value === null)
    return { ...DEFAULT_PRIVACY };
  const record = value as Record<string, unknown>;
  if (record.version !== PRIVACY_VERSION) return { ...DEFAULT_PRIVACY };
  const usageAnalytics = record.usageAnalytics === true;
  const crashReporting = record.crashReporting === true;
  const distinctId = record.posthogDistinctId;
  return {
    version: PRIVACY_VERSION,
    usageAnalytics,
    crashReporting,
    ...(usageAnalytics && typeof distinctId === 'string' && distinctId !== ''
      ? { posthogDistinctId: distinctId }
      : {}),
  };
}

export function readTelemetryPrivacySync(): StoredTelemetryPrivacy {
  try {
    return parsePrivacy(
      JSON.parse(readFileSync(telemetryPrivacyPath(), 'utf8')) as unknown,
    );
  } catch {
    return { ...DEFAULT_PRIVACY };
  }
}

export async function readTelemetryPrivacy(): Promise<StoredTelemetryPrivacy> {
  try {
    return parsePrivacy(
      JSON.parse(await readFile(telemetryPrivacyPath(), 'utf8')) as unknown,
    );
  } catch {
    return { ...DEFAULT_PRIVACY };
  }
}

export async function updateTelemetryPrivacy(
  current: StoredTelemetryPrivacy,
  update: TelemetryConsentUpdate,
): Promise<StoredTelemetryPrivacy> {
  const usageAnalytics = update.usageAnalytics ?? current.usageAnalytics;
  const crashReporting = update.crashReporting ?? current.crashReporting;
  const next: StoredTelemetryPrivacy = {
    version: PRIVACY_VERSION,
    usageAnalytics,
    crashReporting,
    ...(usageAnalytics
      ? { posthogDistinctId: current.posthogDistinctId ?? randomUUID() }
      : {}),
  };
  const path = telemetryPrivacyPath();
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(next, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporaryPath, path);
  return next;
}

export function publicConsent(
  privacy: StoredTelemetryPrivacy,
  crashReportingActive: boolean,
): TelemetryConsent {
  return {
    usageAnalytics: privacy.usageAnalytics,
    crashReporting: privacy.crashReporting,
    crashReportingActive,
  };
}
