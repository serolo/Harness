import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TelemetryConsentControls } from './TelemetryConsentControls';

afterEach(() => {
  cleanup();
  delete (window as unknown as { api?: unknown }).api;
});

describe('TelemetryConsentControls', () => {
  it('loads disabled defaults and updates each choice independently', async () => {
    const invoke = vi.fn((channel: string, req: unknown) => {
      if (channel === 'privacy:getTelemetryConsent') {
        return Promise.resolve({
          usageAnalytics: false,
          crashReporting: false,
          crashReportingActive: false,
        });
      }
      if (channel === 'privacy:setTelemetryConsent') {
        const update = req as {
          usageAnalytics?: boolean;
          crashReporting?: boolean;
        };
        return Promise.resolve({
          usageAnalytics: update.usageAnalytics ?? false,
          crashReporting: update.crashReporting ?? false,
          crashReportingActive: false,
        });
      }
      return Promise.reject(new Error('unexpected channel'));
    });
    (window as unknown as { api: unknown }).api = {
      invoke,
      on: vi.fn(() => () => undefined),
      stream: vi.fn(),
      cancelStream: vi.fn(),
      getPathForFile: vi.fn(),
    };

    render(<TelemetryConsentControls />);
    const usage = await screen.findByTestId('telemetry-usage-toggle');
    const crashes = screen.getByTestId('telemetry-crash-toggle');
    expect(usage).toHaveAttribute('aria-checked', 'false');
    expect(crashes).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(usage);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('privacy:setTelemetryConsent', {
        usageAnalytics: true,
      }),
    );
    expect(crashes).toHaveAttribute('aria-checked', 'false');
  });
});
