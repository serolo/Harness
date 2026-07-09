// OnboardingWizard tests (Phase 6, Track H3). Runs under jsdom with a stubbed `window.api`.
// Covers: the wizard stays hidden when onboarding state is unavailable or already
// acknowledged; it renders the setup steps + the unsandboxed-exec disclosure; and the
// acknowledgement checkbox gates "Get started", which persists the ack and hides it.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { OnboardingWizard } from './OnboardingWizard';
import type { OnboardingState } from '@shared/ipc';

const ACK_KEY = 'harness.onboarding.acknowledged';

function installApi(state: OnboardingState | undefined): {
  invoke: ReturnType<typeof vi.fn>;
} {
  const invoke = vi.fn((channel: string) => {
    if (channel === 'onboarding:state') return Promise.resolve(state);
    return Promise.resolve(undefined);
  });
  (window as unknown as { api: unknown }).api = {
    invoke,
    on: vi.fn(() => () => {}),
    stream: vi.fn(() => Promise.resolve()),
  };
  return { invoke };
}

const INCOMPLETE: OnboardingState = {
  harnessReady: true,
  githubConnected: false,
  hasProjects: false,
  complete: false,
};

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  delete (window as unknown as { api?: unknown }).api;
});

describe('OnboardingWizard', () => {
  it('renders nothing when onboarding state is unavailable', async () => {
    const { invoke } = installApi(undefined);
    render(<OnboardingWizard />);
    // Flush the fetch (it resolves undefined) — the wizard must still never appear.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('onboarding:state', undefined),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('onboarding-wizard')).toBeNull(),
    );
  });

  it('does not fetch or show once already acknowledged', () => {
    window.localStorage.setItem(ACK_KEY, '1');
    const { invoke } = installApi(INCOMPLETE);
    render(<OnboardingWizard />);
    expect(screen.queryByTestId('onboarding-wizard')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('shows setup steps + the unsandboxed-exec disclosure', async () => {
    installApi(INCOMPLETE);
    render(<OnboardingWizard />);

    await screen.findByTestId('onboarding-wizard');

    // A ready step and a to-do step reflect the state.
    expect(screen.getByTestId('onboarding-step-harness')).toHaveAttribute(
      'data-done',
      'true',
    );
    expect(screen.getByTestId('onboarding-step-project')).toHaveAttribute(
      'data-done',
      'false',
    );

    // The disclosure is present and names the key security facts.
    const disclosure = screen.getByTestId('onboarding-disclosure');
    expect(disclosure).toHaveTextContent(/not sandboxed/i);
    expect(disclosure).toHaveTextContent(/user account’s privileges/i);
  });

  it('gates "Get started" on the acknowledgement, then persists + hides', async () => {
    installApi(INCOMPLETE);
    render(<OnboardingWizard />);

    const button = (await screen.findByTestId(
      'onboarding-continue',
    )) as HTMLButtonElement;
    // Disabled until the disclosure is acknowledged.
    expect(button.disabled).toBe(true);

    fireEvent.click(screen.getByTestId('onboarding-ack'));
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.queryByTestId('onboarding-wizard')).toBeNull(),
    );
    expect(window.localStorage.getItem(ACK_KEY)).toBe('1');
  });
});
