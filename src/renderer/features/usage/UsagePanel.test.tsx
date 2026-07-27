import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { UsagePanel } from './UsagePanel';

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('UsagePanel', () => {
  it('renders the monthly total and per-model breakdown', async () => {
    const invoke = vi.fn(() =>
      Promise.resolve({
        month: '2026-07',
        totalCostMicros: 1_250_000,
        inputTokens: 10_000,
        cachedInputTokens: 2_000,
        outputTokens: 1_000,
        turns: 3,
        unpricedTurns: 1,
        models: [
          {
            harness: 'codex',
            model: 'codex-gpt-5-6-terra',
            costMicros: 1_250_000,
            inputTokens: 10_000,
            cachedInputTokens: 2_000,
            outputTokens: 1_000,
            turns: 2,
          },
        ],
      }),
    );
    (window as unknown as { api: unknown }).api = {
      invoke,
      on: vi.fn(() => () => {}),
      stream: vi.fn(),
      cancelStream: vi.fn(),
      getPathForFile: vi.fn(),
    };

    render(<UsagePanel onClose={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByText('codex-gpt-5-6-terra')).toBeInTheDocument(),
    );
    expect(screen.getAllByText('$1.25')).toHaveLength(2);
    expect(screen.getByText(/1 turn could not be priced/)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith(
      'usage:monthly',
      expect.objectContaining({ month: expect.stringMatching(/^\d{4}-\d{2}$/) }),
    );
  });
});
