import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRunPolicy } from '@shared/agents';
import { setUserDataRoot } from '../paths';
import {
  ControlBroker,
  type BrokerRequest,
  type BrokerSessionPolicy,
  type ControlBrokerHandler,
} from './control-broker';
import { callBroker, type BrokerAuth } from './proxy-client';

const policy: AgentRunPolicy = {
  maxDispatches: 4,
  maxParallel: 2,
  maxDepth: 1,
  turnTimeoutMs: 10_000,
  runTimeoutMs: 60_000,
  maxRequestBytes: 4_096,
  maxResultBytes: 4_096,
  critiqueRounds: 0,
};

const session: BrokerSessionPolicy = {
  runId: 'proxy-client-run',
  projectId: 'project-1',
  roles: new Map([
    ['worker', { providers: ['codex'], purposes: ['implement'] }],
  ]),
  policy,
};

function fakeHandler(
  overrides: Partial<ControlBrokerHandler> = {},
): ControlBrokerHandler {
  return {
    dispatch: vi.fn(async (_session, params) => ({
      method: 'dispatch',
      params,
    })),
    continueDispatch: vi.fn(async (_session, params) => ({
      method: 'continue_dispatch',
      params,
    })),
    awaitDispatches: vi.fn(async (_session, params) => ({
      method: 'await_dispatches',
      params,
    })),
    cancelDispatch: vi.fn(async (_session, params) => ({
      method: 'cancel_dispatch',
      params,
    })),
    ...overrides,
  };
}

interface TestPeer {
  auth: BrokerAuth;
  server: Server;
  sockets: Set<Socket>;
}

let root: string;
let peers: TestPeer[];
let brokers: ControlBroker[];

async function createPeer(
  respond: (socket: Socket, request: BrokerRequest) => void,
): Promise<TestPeer> {
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\harness-proxy-${process.pid}-${peers.length}-${randomUUID()}`
      : join(root, `peer-${peers.length}.sock`);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let request = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      request = Buffer.concat([request, chunk]);
      const newline = request.indexOf(10);
      if (newline < 0) return;
      socket.pause();
      respond(
        socket,
        JSON.parse(
          request.subarray(0, newline).toString('utf8'),
        ) as BrokerRequest,
      );
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const peer = {
    auth: { socketPath, token: 'private-test-token' },
    server,
    sockets,
  };
  peers.push(peer);
  return peer;
}

async function startBroker(handler = fakeHandler()): Promise<{
  broker: ControlBroker;
  auth: BrokerAuth;
  authFile: string;
  handler: ControlBrokerHandler;
}> {
  const broker = new ControlBroker(handler);
  brokers.push(broker);
  const control = await broker.start(session);
  const auth = JSON.parse(readFileSync(control.authFile, 'utf8')) as BrokerAuth;
  return { broker, auth, authFile: control.authFile, handler };
}

beforeEach(() => {
  root = mkdtempSync(
    process.platform === 'win32'
      ? join(tmpdir(), 'harness-proxy-client-')
      : '/tmp/harness-proxy-client-',
  );
  peers = [];
  brokers = [];
  setUserDataRoot(root);
});

afterEach(async () => {
  await Promise.all(brokers.map((broker) => broker.shutdown()));
  await Promise.all(
    peers.map(async ({ server, sockets }) => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) => {
        if (!server.listening) return resolveClose();
        server.close(() => resolveClose());
      });
    }),
  );
  setUserDataRoot(undefined);
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('callBroker transport', () => {
  it('accepts one newline-delimited success response after partial chunks', async () => {
    const peer = await createPeer((socket, request) => {
      const frame = `${JSON.stringify({
        id: request.id,
        ok: true,
        result: { accepted: request.params },
      })}\n`;
      const split = Math.floor(frame.length / 2);
      socket.write(frame.slice(0, split), () => socket.end(frame.slice(split)));
    });

    await expect(
      callBroker(peer.auth, 'dispatch', { prompt: 'split response' }),
    ).resolves.toEqual({ accepted: { prompt: 'split response' } });
  });

  it('surfaces broker errors without leaking the capability or control path', async () => {
    const peer = await createPeer((socket, request) => {
      socket.end(
        `${JSON.stringify({
          id: request.id,
          ok: false,
          error: `failed with ${peer.auth.token} at ${peer.auth.socketPath}`,
        })}\n`,
      );
    });

    const error = await callBroker(peer.auth, 'dispatch', {}).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('[redacted]');
    expect((error as Error).message).toContain('[private control path]');
    expect((error as Error).message).not.toContain(peer.auth.token);
    expect((error as Error).message).not.toContain(peer.auth.socketPath);
  });

  it('uses only the first complete response frame and settles once', async () => {
    const peer = await createPeer((socket, request) => {
      socket.end(
        `${JSON.stringify({ id: request.id, ok: true, result: 'first' })}\n${JSON.stringify(
          { id: request.id, ok: false, error: 'late failure' },
        )}\n`,
      );
    });

    await expect(callBroker(peer.auth, 'dispatch', {})).resolves.toBe('first');
  });

  it.each([
    ['malformed JSON', () => '{not json}\n'],
    [
      'the wrong request id',
      () => `${JSON.stringify({ id: 'other-id', ok: true, result: 1 })}\n`,
    ],
    [
      'a missing ok discriminator',
      (request: BrokerRequest) =>
        `${JSON.stringify({ id: request.id, result: 1 })}\n`,
    ],
  ])('rejects a response with %s', async (_label, frameFor) => {
    const peer = await createPeer((socket, request) => {
      socket.end(frameFor(request));
    });

    await expect(callBroker(peer.auth, 'dispatch', {})).rejects.toThrow(
      'invalid control response',
    );
  });

  it('rejects when the peer closes before a complete response', async () => {
    const peer = await createPeer((socket) => socket.end());

    await expect(callBroker(peer.auth, 'dispatch', {})).rejects.toThrow(
      'control service unavailable',
    );
  });

  it('normalizes a socket connection error', async () => {
    const unavailable: BrokerAuth = {
      socketPath: join(root, 'missing.sock'),
      token: 'private-test-token',
    };

    await expect(callBroker(unavailable, 'dispatch', {})).rejects.toThrow(
      'control service unavailable',
    );
  });

  it('times out a peer that remains connected without responding', async () => {
    const peer = await createPeer(() => undefined);

    await expect(
      callBroker(peer.auth, 'dispatch', {}, { timeoutMs: 20 }),
    ).rejects.toThrow('control request timed out');
  });

  it('rejects a response before buffering beyond the configured byte limit', async () => {
    const peer = await createPeer((socket) => {
      socket.end(`${'x'.repeat(65)}\n`);
    });

    await expect(
      callBroker(peer.auth, 'dispatch', {}, { maxResponseBytes: 64 }),
    ).rejects.toThrow('control response too large');
  });

  it('validates private configuration and call limits before opening a socket', async () => {
    await expect(
      callBroker({ socketPath: '', token: 'x' }, 'dispatch', {}),
    ).rejects.toThrow('invalid private control configuration');
    await expect(
      callBroker(
        { socketPath: join(root, 'missing.sock'), token: 'x' },
        'dispatch',
        {},
        { timeoutMs: 0 },
      ),
    ).rejects.toThrow('invalid broker call options');
    await expect(
      callBroker(
        { socketPath: join(root, 'missing.sock'), token: 'x' },
        'dispatch',
        BigInt(1),
      ),
    ).rejects.toThrow('invalid control request');
  });
});

describe('ControlBroker and proxy integration', () => {
  it('round-trips dispatch, continue, await, and cancel through the real socket', async () => {
    const { auth, handler } = await startBroker();

    for (const [method, params] of [
      ['dispatch', { role: 'worker', prompt: 'implement' }],
      ['continue_dispatch', { dispatchId: 'dispatch-1', prompt: 'follow up' }],
      ['await_dispatches', { dispatchIds: ['dispatch-1'] }],
      ['cancel_dispatch', { dispatchId: 'dispatch-1' }],
    ] as const) {
      await expect(callBroker(auth, method, params)).resolves.toMatchObject({
        method,
        params,
      });
    }

    expect(handler.dispatch).toHaveBeenCalledTimes(1);
    expect(handler.continueDispatch).toHaveBeenCalledTimes(1);
    expect(handler.awaitDispatches).toHaveBeenCalledTimes(1);
    expect(handler.cancelDispatch).toHaveBeenCalledTimes(1);
  });

  it('times out once without causing EPIPE when the broker handler finishes late', async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolvePending) => {
      finish = resolvePending;
    });
    const { auth, handler } = await startBroker(
      fakeHandler({ dispatch: vi.fn(async () => pending) }),
    );

    await expect(
      callBroker(auth, 'dispatch', {}, { timeoutMs: 20 }),
    ).rejects.toThrow('control request timed out');
    finish({ tooLate: true });

    await vi.waitFor(() => expect(handler.dispatch).toHaveBeenCalledTimes(1));
  });

  const proxyEntry = resolve('out/main/mcp-stdio.js');
  it.skipIf(!existsSync(proxyEntry))(
    'exposes the four bounded tools through the built stdio MCP entry',
    async () => {
      const { authFile, handler } = await startBroker();
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [proxyEntry],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          HARNESS_META_CONTROL_FILE: authFile,
        },
        stderr: 'pipe',
      });
      const client = new Client({ name: 'proxy-smoke', version: '1.0.0' });
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
          'await_dispatches',
          'cancel_dispatch',
          'continue_dispatch',
          'dispatch',
        ]);
        const result = await client.callTool({
          name: 'dispatch',
          arguments: {
            role: 'worker',
            purpose: 'implement',
            prompt: 'stdio smoke',
          },
        });
        expect(result.content).toEqual([
          {
            type: 'text',
            text: JSON.stringify({
              method: 'dispatch',
              params: {
                role: 'worker',
                purpose: 'implement',
                prompt: 'stdio smoke',
              },
            }),
          },
        ]);
        expect(handler.dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await client.close();
      }
    },
  );
});
