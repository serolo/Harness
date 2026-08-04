// OnboardingWizard tests (Phase 6, Track H3). Runs under jsdom with a stubbed `window.api`.
// Covers: the wizard stays hidden when onboarding state is unavailable or already
// acknowledged; it renders the setup steps + the unsandboxed-exec disclosure; and the
// acknowledgement checkbox gates "Get started", which persists the ack and hides it.

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { OnboardingWizard } from './OnboardingWizard';
import type { OnboardingState } from '@shared/ipc';
import { createQueryClient } from '@renderer/app/providers';

vi.mock('./OnboardingLoginTerminal', () => ({
  OnboardingLoginTerminal: ({ provider }: { provider: string }) => (
    <div data-testid="onboarding-login-terminal">{provider}</div>
  ),
}));

function installApi(state: OnboardingState | undefined): {
  invoke: ReturnType<typeof vi.fn>;
} {
  const invoke = vi.fn((channel: string) => {
    if (channel === 'onboarding:state') return Promise.resolve(state);
    if (channel === 'knowledge:installQmd') {
      return Promise.resolve({ installed: true, version: 'qmd 2.1.0' });
    }
    if (channel === 'onboarding:acknowledge') return Promise.resolve();
    if (channel === 'github:cliStatus') {
      return Promise.resolve({ available: true, authenticated: false });
    }
    if (channel === 'github:connectGhCli') return Promise.resolve({});
    if (channel === 'harness:detect') {
      return Promise.resolve({ installed: true, authenticated: false });
    }
    if (channel === 'settings:getEffective') {
      return Promise.resolve({
        appearance: { theme: 'dark' },
        notifications: { completionSound: 'none' },
      });
    }
    if (channel === 'settings:getProvenance') return Promise.resolve({});
    if (channel === 'settings:getIssues') return Promise.resolve([]);
    if (channel === 'settings:set') {
      return Promise.resolve({
        appearance: { theme: 'light' },
        notifications: { completionSound: 'none' },
      });
    }
    return Promise.resolve(undefined);
  });
  (window as unknown as { api: unknown }).api = {
    invoke,
    on: vi.fn(() => () => {}),
    stream: vi.fn(() => Promise.resolve()),
  };
  return { invoke };
}

function renderWizard(): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <OnboardingWizard />
    </QueryClientProvider>,
  );
}

const INCOMPLETE: OnboardingState = {
  harnessReady: true,
  githubConnected: false,
  hasProjects: false,
  qmdInstalled: false,
  acknowledged: false,
  complete: false,
  claudeReady: true,
  codexReady: false,
};

const READY: OnboardingState = {
  ...INCOMPLETE,
  githubConnected: true,
  complete: true,
};

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('OnboardingWizard', () => {
  it('renders nothing when onboarding state is unavailable', async () => {
    const { invoke } = installApi(undefined);
    renderWizard();
    // Flush the fetch (it resolves undefined) — the wizard must still never appear.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('onboarding:state', undefined),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('onboarding-wizard')).toBeNull(),
    );
  });

  it('does not fetch or show once already acknowledged', () => {
    const { invoke } = installApi({ ...INCOMPLETE, acknowledged: true });
    renderWizard();
    return waitFor(() => {
      expect(screen.queryByTestId('onboarding-wizard')).toBeNull();
      expect(invoke).toHaveBeenCalledWith('onboarding:state', undefined);
    });
  });

  it('shows setup steps + the unsandboxed-exec disclosure', async () => {
    installApi(INCOMPLETE);
    renderWizard();

    await screen.findByTestId('onboarding-wizard');

    expect(screen.getByTestId('onboarding-step-claude')).toHaveAttribute(
      'data-done',
      'true',
    );
    expect(screen.getByTestId('onboarding-step-codex')).toHaveAttribute(
      'data-done',
      'false',
    );
    expect(screen.getByTestId('onboarding-step-github')).toHaveAttribute(
      'data-done',
      'false',
    );
    expect(screen.queryByTestId('onboarding-step-project')).toBeNull();
    expect(screen.getByTestId('onboarding-step-qmd')).toHaveAttribute(
      'data-done',
      'false',
    );
    expect(screen.queryByText('Linear')).toBeNull();
    expect(screen.getByText('Theme')).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-theme')).toHaveValue('dark');
    expect(screen.getByText('Completion sound')).toBeInTheDocument();

    // The disclosure is present and names the key security facts.
    const disclosure = screen.getByTestId('onboarding-disclosure');
    expect(disclosure).toHaveTextContent(/not sandboxed/i);
    expect(disclosure).toHaveTextContent(/user account’s privileges/i);
  });

  it('opens the GitHub login terminal when gh is not authenticated', async () => {
    const { invoke } = installApi(INCOMPLETE);
    renderWizard();

    const githubCard = await screen.findByTestId('onboarding-step-github');
    fireEvent.click(within(githubCard).getByText('GitHub'));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('github:cliStatus', undefined),
    );
    expect(
      await screen.findByTestId('onboarding-login-terminal'),
    ).toHaveTextContent('github');
  });

  it('checks Codex auth before opening its login terminal', async () => {
    const { invoke } = installApi(INCOMPLETE);
    renderWizard();

    const codexCard = await screen.findByTestId('onboarding-step-codex');
    fireEvent.click(within(codexCard).getByRole('button', { name: 'Sign in' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('harness:detect', { id: 'codex' }),
    );
    expect(
      await screen.findByTestId('onboarding-login-terminal'),
    ).toHaveTextContent('codex');
  });

  it('persists the selected theme through user settings', async () => {
    const { invoke } = installApi(INCOMPLETE);
    renderWizard();

    fireEvent.change(await screen.findByTestId('onboarding-theme'), {
      target: { value: 'light' },
    });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('settings:set', {
        layer: 'user',
        keyPath: 'appearance.theme',
        value: 'light',
      }),
    );
  });

  it('offers an optional QMD installation', async () => {
    const { invoke } = installApi(INCOMPLETE);
    renderWizard();

    fireEvent.click(await screen.findByRole('button', { name: 'Install QMD' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('knowledge:installQmd', undefined),
    );
    expect(screen.getByTestId('onboarding-step-qmd')).toHaveAttribute(
      'data-done',
      'true',
    );
  });

  it('requires readiness and acknowledgement, then persists + hides', async () => {
    installApi(READY);
    renderWizard();

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
    expect(window.api.invoke).toHaveBeenCalledWith(
      'onboarding:acknowledge',
      undefined,
    );
  });

  it('does not finish when GitHub is missing', async () => {
    installApi(INCOMPLETE);
    renderWizard();

    const button = (await screen.findByTestId(
      'onboarding-continue',
    )) as HTMLButtonElement;
    fireEvent.click(screen.getByTestId('onboarding-ack'));
    expect(button.disabled).toBe(true);
  });
});
