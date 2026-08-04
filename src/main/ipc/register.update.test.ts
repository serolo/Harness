// Updater IPC trust-boundary coverage. The read command is hydration-only, and
// updater failures must pass through the same encoded AppError boundary as every
// other privileged main-process command.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

const capturedHandlers = new Map<string, unknown>();
const logError = vi.hoisted(() => vi.fn());
vi.mock('electron', () => {
  const noop = (): void => {};
  const app = new Proxy(
    {
      isPackaged: false,
      getName: () => 'test',
      getVersion: () => '0.0.0',
      getPath: () => '/tmp',
    } as Record<string, unknown>,
    { get: (target, key) => (key in target ? target[key as string] : noop) },
  );
  return {
    app,
    dialog: {},
    nativeImage: {},
    BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
    ipcMain: {
      handle: (channel: string, handler: unknown) =>
        capturedHandlers.set(channel, handler),
      on: noop,
      removeHandler: noop,
      removeAllListeners: noop,
    },
    MessageChannelMain: class {},
  };
});
vi.mock('../logging', () => ({
  logger: { error: logError },
}));

import { registerIpc } from './register';
import type { AppContext } from '../context';
import {
  AppError,
  decodeAppErrorMessage,
  type AppErrorCode,
} from '@shared/errors';
import type {
  CommandChannel,
  CommandReq,
  CommandRes,
  UpdateStatus,
} from '@shared/ipc';

type Handler = (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>;
const EVENT = { sender: {} } as unknown as IpcMainInvokeEvent;

async function invoke<C extends CommandChannel>(
  channel: C,
  req: CommandReq<C>,
): Promise<CommandRes<C>> {
  const handler = capturedHandlers.get(channel) as Handler | undefined;
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return (await handler(EVENT, req)) as CommandRes<C>;
}

async function rejectedCode(
  channel: 'update:install',
): Promise<AppErrorCode | undefined> {
  try {
    await invoke(channel, undefined);
    return undefined;
  } catch (error) {
    return decodeAppErrorMessage(error instanceof Error ? error.message : '')
      ?.code;
  }
}

beforeEach(() => {
  capturedHandlers.clear();
  logError.mockClear();
});

describe('updater IPC handlers', () => {
  it('returns the current snapshot without starting a network check', async () => {
    const snapshot: UpdateStatus = {
      state: 'downloading',
      currentVersion: '1.0.0',
      version: '1.1.0',
      percent: 42,
    };
    const getStatus = vi.fn(() => snapshot);
    const checkForUpdates = vi.fn();

    registerIpc({
      updater: { getStatus, checkForUpdates },
    } as unknown as AppContext);

    await expect(invoke('update:getStatus', undefined)).resolves.toEqual(
      snapshot,
    );
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(checkForUpdates).not.toHaveBeenCalled();
  });

  it('keeps install failures inside the encoded typed-error boundary', async () => {
    const install = vi.fn(async () => {
      throw new AppError('not_found', 'No verified update is ready.');
    });
    registerIpc({ updater: { install } } as unknown as AppContext);

    await expect(rejectedCode('update:install')).resolves.toBe('not_found');
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('normalizes unexpected install failures instead of leaking raw thrown values', async () => {
    const install = vi.fn(async () => {
      throw 'signed-url-with-secret'; // eslint-disable-line no-throw-literal
    });
    registerIpc({ updater: { install } } as unknown as AppContext);

    const handler = capturedHandlers.get('update:install') as
      Handler | undefined;
    expect(handler).toBeDefined();

    let boundaryMessage = '';
    try {
      await handler!(EVENT, undefined);
    } catch (error) {
      boundaryMessage = error instanceof Error ? error.message : String(error);
    }

    expect(decodeAppErrorMessage(boundaryMessage)?.code).toBe('internal');
    expect(boundaryMessage).not.toContain('signed-url-with-secret');
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls.flat().join(' ')).not.toContain(
      'signed-url-with-secret',
    );
  });
});
