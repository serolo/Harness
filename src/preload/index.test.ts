import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

const electron = vi.hoisted(() => {
  const listeners = new Map<string, Listener>();
  const exposed: { api?: unknown } = {};
  return {
    listeners,
    exposed,
    contextBridge: {
      exposeInMainWorld: vi.fn((_key: string, value: unknown) => {
        exposed.api = value;
      }),
    },
    ipcRenderer: {
      invoke: vi.fn(),
      on: vi.fn((channel: string, listener: Listener) => {
        listeners.set(channel, listener);
      }),
      removeListener: vi.fn((channel: string) => {
        listeners.delete(channel);
      }),
      send: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  contextBridge: electron.contextBridge,
  ipcRenderer: electron.ipcRenderer,
}));

import './index';

interface ExposedApi {
  stream(
    channel: 'app:echoStream',
    arg: { text: string },
    onChunk: (chunk: string) => void,
    opts: { id: string },
  ): Promise<void>;
  cancelStream(id: string): void;
}

const STREAM_ID = '123e4567-e89b-42d3-a456-426614174000';

beforeEach(() => {
  electron.listeners.clear();
  electron.ipcRenderer.invoke.mockReset();
  electron.ipcRenderer.on.mockClear();
  electron.ipcRenderer.removeListener.mockClear();
  electron.ipcRenderer.send.mockClear();
});

describe('preload stream startup', () => {
  it('attaches the data listener before a fast producer can emit', async () => {
    electron.ipcRenderer.invoke.mockImplementation(
      (_channel: string, payload: unknown) => {
        const id = (payload as { id: string }).id;
        const listener = electron.listeners.get(`stream:${id}`);
        if (!listener)
          return Promise.reject(new Error('listener was not ready'));

        listener({}, { t: 'chunk', chunk: 'instant output' });
        listener({}, { t: 'end' });
        return Promise.resolve({ id });
      },
    );

    const api = electron.exposed.api as ExposedApi;
    const chunks: string[] = [];
    await expect(
      api.stream(
        'app:echoStream',
        { text: 'hello' },
        (chunk) => chunks.push(chunk),
        { id: STREAM_ID },
      ),
    ).resolves.toBeUndefined();

    expect(chunks).toEqual(['instant output']);
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledOnce();
  });

  it('cancels by serializable subscription id without receiving an AbortSignal', async () => {
    electron.ipcRenderer.invoke.mockImplementation(
      () => new Promise(() => undefined),
    );

    const api = electron.exposed.api as ExposedApi;
    const pending = api.stream(
      'app:echoStream',
      { text: 'hello' },
      () => undefined,
      { id: STREAM_ID },
    );

    api.cancelStream(STREAM_ID);

    await expect(pending).rejects.toMatchObject({
      __appError: true,
      message: 'stream aborted',
    });
    expect(electron.ipcRenderer.send).toHaveBeenCalledWith(
      'stream:cancel',
      STREAM_ID,
    );
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(
      `stream:${STREAM_ID}`,
      expect.any(Function),
    );
  });
});
