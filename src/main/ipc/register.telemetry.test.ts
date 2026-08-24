import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

const capturedHandlers = new Map<string, unknown>();
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

import { decodeAppErrorMessage } from '@shared/errors';
import type { AppContext } from '../context';
import { registerIpc } from './register';

type Handler = (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>;
const EVENT = { sender: {} } as unknown as IpcMainInvokeEvent;

async function call(channel: string, req: unknown): Promise<unknown> {
  const handler = capturedHandlers.get(channel) as Handler | undefined;
  if (!handler) throw new Error(`missing handler: ${channel}`);
  return handler(EVENT, req);
}

beforeEach(() => capturedHandlers.clear());

describe('telemetry privacy IPC', () => {
  it('reads and independently updates app-global consent', async () => {
    const consent = {
      usageAnalytics: false,
      crashReporting: false,
      crashReportingActive: false,
    };
    const getConsent = vi.fn(() => consent);
    const setConsent = vi.fn(async () => ({
      ...consent,
      usageAnalytics: true,
    }));
    registerIpc({
      telemetry: { getConsent, setConsent },
    } as unknown as AppContext);

    await expect(
      call('privacy:getTelemetryConsent', undefined),
    ).resolves.toEqual(consent);
    await expect(
      call('privacy:setTelemetryConsent', { usageAnalytics: true }),
    ).resolves.toMatchObject({ usageAnalytics: true, crashReporting: false });
    expect(setConsent).toHaveBeenCalledWith({ usageAnalytics: true });
  });

  it('rejects non-boolean and empty updates at the IPC boundary', async () => {
    const setConsent = vi.fn();
    registerIpc({ telemetry: { setConsent } } as unknown as AppContext);

    for (const req of [{}, { crashReporting: 'yes' }, null]) {
      let message = '';
      try {
        await call('privacy:setTelemetryConsent', req);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(decodeAppErrorMessage(message)?.code).toBe('invalid_input');
    }
    expect(setConsent).not.toHaveBeenCalled();
  });
});
