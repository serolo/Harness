import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';

import type { AgentRunPolicy } from '@shared/agents';
import { setUserDataRoot } from '../paths';
import {
  ControlBroker,
  type BrokerRequest,
  type BrokerResponse,
  type BrokerSessionPolicy,
  type ControlBrokerHandler,
  windowsControlPipeName,
} from './control-broker';

let root: string;
let broker: ControlBroker;
let socketPath: string;
let authFile: string;
let token: string;

const policy: AgentRunPolicy = {
  maxDispatches: 4,
  maxParallel: 2,
  maxDepth: 1,
  turnTimeoutMs: 10_000,
  runTimeoutMs: 60_000,
  maxRequestBytes: 1_024,
  maxResultBytes: 1_024,
  critiqueRounds: 0,
};
const session: BrokerSessionPolicy = {
  runId: 'run-1',
  projectId: 'project-1',
  roles: new Map([
    ['worker', { providers: ['codex'], purposes: ['implement'] }],
  ]),
  policy,
};

function handler(
  overrides: Partial<ControlBrokerHandler> = {},
): ControlBrokerHandler {
  return {
    dispatch: vi.fn(async (_session, params) => ({
      method: 'dispatch',
      params,
    })),
    continueDispatch: vi.fn(async (_session, params) => ({
      method: 'continue',
      params,
    })),
    awaitDispatches: vi.fn(async (_session, params) => ({
      method: 'await',
      params,
    })),
    cancelDispatch: vi.fn(async (_session, params) => ({
      method: 'cancel',
      params,
    })),
    ...overrides,
  };
}

async function send(
  request: Partial<BrokerRequest> | string,
): Promise<BrokerResponse> {
  return JSON.parse(await sendRaw(request)) as BrokerResponse;
}

async function sendRaw(
  request: Partial<BrokerRequest> | string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(
        `${typeof request === 'string' ? request : JSON.stringify(request)}\n`,
      );
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        socket.destroy();
        resolve(buffer.slice(0, newline));
      }
    });
  });
}

async function start(
  target = handler(),
  overrides: Partial<AgentRunPolicy> = {},
): Promise<ControlBrokerHandler> {
  broker = new ControlBroker(target);
  const control = await broker.start({
    ...session,
    policy: { ...policy, ...overrides },
  });
  socketPath = control.socketPath;
  authFile = control.authFile;
  token = (JSON.parse(readFileSync(authFile, 'utf8')) as { token: string })
    .token;
  return target;
}

beforeEach(() => {
  // Keep transport-focused cases under the macOS sockaddr_un limit. A separate
  // start-path regression covers long user-data roots.
  root = mkdtempSync(join(tmpdir(), 'hcb-'));
  setUserDataRoot(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await broker?.shutdown();
  setUserDataRoot(undefined);
  rmSync(root, { recursive: true, force: true });
});

describe('ControlBroker authorization and transport', () => {
  it('creates unguessable Windows named-pipe endpoints without filesystem paths', () => {
    expect(windowsControlPipeName('a'.repeat(32))).toBe(
      '\\\\.\\pipe\\harness-meta-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(() => windowsControlPipeName('../unsafe')).toThrow(/invalid/);
  });

  it('starts when the user-data root is longer than the macOS socket-path limit', async () => {
    const longRoot = join(root, 'x'.repeat(120));
    mkdirSync(longRoot, { recursive: true });
    setUserDataRoot(longRoot);

    await start();

    expect(socketPath.length).toBeLessThan(104);
    expect(authFile).toContain(longRoot);
  });

  it('stores the secret out of argv in a private file and routes only closed methods', async () => {
    const target = await start();
    if (process.platform !== 'win32') {
      expect(statSync(authFile).mode & 0o777).toBe(0o600);
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    } else {
      expect(statSync(authFile).isFile()).toBe(true);
      expect(socketPath).toMatch(/^\\\\\.\\pipe\\harness-meta-/);
    }
    expect(authFile).not.toContain(token);

    for (const [id, method] of [
      ['1', 'dispatch'],
      ['2', 'continue_dispatch'],
      ['3', 'await_dispatches'],
      ['4', 'cancel_dispatch'],
    ] as const) {
      expect(
        await send({ id, token, method, params: { marker: method } }),
      ).toMatchObject({ id, ok: true });
    }
    expect(target.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', projectId: 'project-1' }),
      { marker: 'dispatch' },
    );
    expect(
      await send({
        id: '5',
        token,
        method: 'ipc:invoke' as 'dispatch',
        params: {},
      }),
    ).toEqual({ id: '5', ok: false, error: 'unsupported method' });
  });

  it('rejects malformed frames, wrong tokens, expiry, and replay without invoking handlers', async () => {
    const target = await start();
    expect(await send('{bad json')).toEqual({
      id: '',
      ok: false,
      error: 'invalid request',
    });
    expect(
      await send({
        id: 'wrong',
        token: 'not-the-token',
        method: 'dispatch',
        params: {},
      }),
    ).toMatchObject({ ok: false, error: 'unauthorized or expired capability' });

    expect(
      await send({ id: 'once', token, method: 'dispatch', params: {} }),
    ).toMatchObject({
      ok: true,
    });
    expect(
      await send({ id: 'once', token, method: 'dispatch', params: {} }),
    ).toMatchObject({
      ok: false,
      error: 'duplicate request',
    });

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + policy.runTimeoutMs + 1);
    expect(
      await send({ id: 'expired', token, method: 'dispatch', params: {} }),
    ).toMatchObject({ ok: false, error: 'unauthorized or expired capability' });
    expect(target.dispatch).toHaveBeenCalledTimes(1);
  });

  it('enforces request and result byte budgets before returning provider data', async () => {
    const target = handler({
      dispatch: vi.fn(async () => ({ summary: 'x'.repeat(2_000) })),
    });
    await start(target);

    expect(
      await send({
        id: 'large-request',
        token,
        method: 'dispatch',
        params: { prompt: 'x'.repeat(2_000) },
      }),
    ).toMatchObject({ ok: false, error: 'request budget exceeded' });
    expect(target.dispatch).not.toHaveBeenCalled();

    const response = await send({
      id: 'large-result',
      token,
      method: 'dispatch',
      params: {},
    });
    expect(response).toMatchObject({
      ok: true,
      result: { truncated: true },
    });
    expect(JSON.stringify(response.result).length).toBeLessThan(1_200);
  });

  it('bounds the complete newline-delimited response frame after JSON escaping', async () => {
    const target = handler({
      dispatch: vi.fn(async () => ({
        summary: '"\\😀\n'.repeat(2_000),
      })),
    });
    await start(target, { maxResultBytes: 1_024 });

    const frame = await sendRaw({
      id: 'escaped-result',
      token,
      method: 'dispatch',
      params: {},
    });
    const response = JSON.parse(frame) as BrokerResponse;

    expect(Buffer.byteLength(`${frame}\n`, 'utf8')).toBeLessThanOrEqual(1_024);
    expect(response).toMatchObject({
      id: 'escaped-result',
      ok: true,
      result: { truncated: true },
    });
  });

  it('redacts capability tokens and socket paths from downstream errors', async () => {
    await start(
      handler({
        dispatch: vi.fn(async () => {
          throw new Error(`provider failed with ${token} at ${socketPath}`);
        }),
      }),
    );
    // The closure reads token/path after start has assigned them.
    const response = await send({
      id: 'redact',
      token,
      method: 'dispatch',
      params: {},
    });
    expect(response.ok).toBe(false);
    expect(response.error).toContain('[redacted]');
    expect(response.error).toContain('[private control path]');
    expect(response.error).not.toContain(token);
    expect(response.error).not.toContain(socketPath);
  });

  it('revocation and shutdown remove all control artifacts and reject future reuse', async () => {
    await start();
    await broker.revoke('run-1');
    expect(() => statSync(authFile)).toThrow();
    expect(() => statSync(socketPath)).toThrow();
    await expect(
      send({ id: 'after-revoke', token, method: 'dispatch', params: {} }),
    ).rejects.toBeDefined();
    await expect(broker.revoke('run-1')).resolves.toBeUndefined();
  });

  it('rejects a second control session for the same run', async () => {
    await start();
    await expect(broker.start(session)).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});
