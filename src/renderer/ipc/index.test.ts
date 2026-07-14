import { afterEach, describe, expect, it, vi } from 'vitest';

import { subscribeStream } from './index';

interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
  cancelStream: ReturnType<typeof vi.fn>;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('subscribeStream cancellation', () => {
  it('keeps AbortSignal in the renderer and cancels preload with a serializable id', async () => {
    let rejectStream: ((reason: unknown) => void) | undefined;
    const stream = vi.fn(
      (_channel: unknown, _arg: unknown, _onChunk: unknown, _opts: unknown) =>
        new Promise<void>((_resolve, reject) => {
          rejectStream = reject;
        }),
    );
    const cancelStream = vi.fn(() => {
      rejectStream?.({
        __appError: true,
        code: 'internal',
        message: 'stream aborted',
      });
    });
    const api: ApiStub = {
      invoke: vi.fn(),
      on: vi.fn(),
      stream,
      cancelStream,
    };
    (window as unknown as { api: ApiStub }).api = api;

    const controller = new AbortController();
    const pending = subscribeStream(
      'app:echoStream',
      { text: 'hello' },
      () => undefined,
      { signal: controller.signal },
    );

    const streamOptions = stream.mock.calls[0]?.[3] as
      { id?: unknown; signal?: unknown } | undefined;
    expect(streamOptions).toEqual({ id: expect.any(String) });
    expect(streamOptions).not.toHaveProperty('signal');

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelStream).toHaveBeenCalledWith(streamOptions?.id);
  });

  it('does not start a stream when the signal is already aborted', async () => {
    const api: ApiStub = {
      invoke: vi.fn(),
      on: vi.fn(),
      stream: vi.fn(),
      cancelStream: vi.fn(),
    };
    (window as unknown as { api: ApiStub }).api = api;
    const controller = new AbortController();
    controller.abort();

    await expect(
      subscribeStream('app:echoStream', { text: 'hello' }, () => undefined, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(api.stream).not.toHaveBeenCalled();
    expect(api.cancelStream).not.toHaveBeenCalled();
  });
});
