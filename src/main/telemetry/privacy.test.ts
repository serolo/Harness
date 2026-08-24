import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setUserDataRoot, telemetryPrivacyPath } from '../paths';
import {
  publicConsent,
  readTelemetryPrivacy,
  readTelemetryPrivacySync,
  updateTelemetryPrivacy,
} from './privacy';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'harness-telemetry-'));
  setUserDataRoot(root);
});

afterEach(async () => {
  setUserDataRoot(undefined);
  await rm(root, { recursive: true, force: true });
});

describe('telemetry privacy persistence', () => {
  it('fails closed for missing, malformed, and unknown-version state', async () => {
    expect(await readTelemetryPrivacy()).toMatchObject({
      usageAnalytics: false,
      crashReporting: false,
    });

    await writeFile(telemetryPrivacyPath(), '{bad', 'utf8');
    expect(readTelemetryPrivacySync().usageAnalytics).toBe(false);

    await writeFile(
      telemetryPrivacyPath(),
      JSON.stringify({
        version: 99,
        usageAnalytics: true,
        crashReporting: true,
      }),
      'utf8',
    );
    expect(await readTelemetryPrivacy()).toMatchObject({
      usageAnalytics: false,
      crashReporting: false,
    });
  });

  it('creates an anonymous id only while usage analytics is enabled', async () => {
    const initial = await readTelemetryPrivacy();
    const enabled = await updateTelemetryPrivacy(initial, {
      usageAnalytics: true,
    });
    expect(enabled.posthogDistinctId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const disabled = await updateTelemetryPrivacy(enabled, {
      usageAnalytics: false,
      crashReporting: true,
    });
    expect(disabled.posthogDistinctId).toBeUndefined();
    expect(publicConsent(disabled, false)).toEqual({
      usageAnalytics: false,
      crashReporting: true,
      crashReportingActive: false,
    });

    const reenabled = await updateTelemetryPrivacy(disabled, {
      usageAnalytics: true,
    });
    expect(reenabled.posthogDistinctId).not.toBe(enabled.posthogDistinctId);
  });
});
