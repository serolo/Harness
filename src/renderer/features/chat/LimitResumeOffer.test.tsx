// LimitResumeOffer test (Phase 12). jsdom + a stubbed `window.api`. Covers: the offer
// renders only for a matching usage-limit error; clicking it invokes `task:create` with
// the parsed resetsAt + `origin: 'limit_resume'`; and it flips to a confirmation state.
// A non-matching message renders nothing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { LimitResumeOffer } from './LimitResumeOffer';

interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
}

function installApi(): ApiStub {
  const api: ApiStub = {
    invoke: vi.fn(() => Promise.resolve({})),
    on: vi.fn(() => vi.fn()),
    stream: vi.fn(() => Promise.resolve()),
  };
  (window as unknown as { api: ApiStub }).api = api;
  return api;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

let api: ApiStub;
beforeEach(() => {
  api = installApi();
});

describe('LimitResumeOffer rendering', () => {
  it('renders nothing for a non-usage-limit error', () => {
    const { container } = render(
      <LimitResumeOffer
        workspaceId="ws1"
        message="claude exited with code 1"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the offer for a usage-limit error', () => {
    render(
      <LimitResumeOffer
        workspaceId="ws1"
        message="Claude AI usage limit reached"
      />,
    );
    expect(screen.getByTestId('limit-resume-offer')).toBeInTheDocument();
  });
});

describe('LimitResumeOffer click', () => {
  it('creates a limit_resume task at the parsed reset time and confirms', async () => {
    const epochSeconds = 1_752_324_000;
    render(
      <LimitResumeOffer
        workspaceId="ws1"
        message={`Claude AI usage limit reached|${epochSeconds}`}
      />,
    );

    fireEvent.click(screen.getByTestId('limit-resume-button'));

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('task:create', {
        workspaceId: 'ws1',
        prompt: 'Continue where you left off.',
        origin: 'limit_resume',
        scheduledAt: epochSeconds * 1000,
      }),
    );
    expect(
      await screen.findByTestId('limit-resume-confirmed'),
    ).toBeInTheDocument();
  });

  it('creates an untimed resume task when no reset time is known', async () => {
    render(
      <LimitResumeOffer
        workspaceId="ws1"
        message="Claude AI usage limit reached"
      />,
    );

    fireEvent.click(screen.getByTestId('limit-resume-button'));

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('task:create', {
        workspaceId: 'ws1',
        prompt: 'Continue where you left off.',
        origin: 'limit_resume',
      }),
    );
  });
});
