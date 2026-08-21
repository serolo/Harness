import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { PrSummary } from '@shared/github';
import { createQueryClient } from '@renderer/app/providers';
import { useWorkspacePr } from './useWorkspacePr';

const OPEN_PR: PrSummary = {
  number: 42,
  url: 'https://github.com/acme/repo/pull/42',
  title: 'Keep polling live state',
  draft: false,
  mergeableState: 'clean',
  state: 'open',
};

function installApi(invoke: ReturnType<typeof vi.fn>): void {
  (window as unknown as { api: unknown }).api = {
    invoke,
    on: vi.fn(() => () => {}),
    stream: vi.fn(),
  };
}

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <QueryClientProvider client={createQueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('useWorkspacePr', () => {
  it('stops interval and focus refetches after a failed lookup', async () => {
    vi.useFakeTimers();
    const invoke = vi.fn(() =>
      Promise.reject(new Error('Connect Timeout Error')),
    );
    installApi(invoke);

    const { result } = renderHook(
      () =>
        useWorkspacePr({
          workspaceId: 'ws-1',
          branch: 'agent/topic',
          prNumber: null,
        }),
      { wrapper },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.error?.message).toBe('Connect Timeout Error');
    expect(invoke).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_001);
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('allows an explicit successful retry and resumes polling', async () => {
    vi.useFakeTimers();
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('GitHub unavailable'))
      .mockResolvedValue(OPEN_PR);
    installApi(invoke);

    const { result } = renderHook(
      () =>
        useWorkspacePr({
          workspaceId: 'ws-1',
          branch: 'agent/topic',
          prNumber: null,
        }),
      { wrapper },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    let retryResult: Awaited<ReturnType<typeof result.current.refetch>>;
    await act(async () => {
      retryResult = await result.current.refetch();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(retryResult!.error).toBeNull();
    expect(retryResult!.data).toEqual(OPEN_PR);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(invoke.mock.calls.length).toBeGreaterThan(2);
  });

  it('keeps last-known PR data when a background refresh fails', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(OPEN_PR)
      .mockRejectedValueOnce(new Error('Connect Timeout Error'));
    installApi(invoke);

    const { result } = renderHook(
      () =>
        useWorkspacePr({
          workspaceId: 'ws-1',
          branch: 'agent/topic',
          prNumber: null,
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data).toEqual(OPEN_PR));

    let refreshResult: Awaited<ReturnType<typeof result.current.refetch>>;
    await act(async () => {
      refreshResult = await result.current.refetch();
    });

    expect(refreshResult!.data).toEqual(OPEN_PR);
    expect(refreshResult!.error?.message).toBe('Connect Timeout Error');
  });
});
