import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { BrokerMethod } from './control-broker';
import { callBroker, type BrokerAuth } from './proxy-client';

async function loadAuth(): Promise<BrokerAuth> {
  const authPath = process.env.HARNESS_META_CONTROL_FILE;
  if (!authPath) throw new Error('Missing private control configuration.');
  try {
    const parsed: unknown = JSON.parse(await readFile(authPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid control configuration');
    }
    const auth = parsed as Partial<BrokerAuth>;
    if (
      typeof auth.socketPath !== 'string' ||
      !auth.socketPath ||
      typeof auth.token !== 'string' ||
      !auth.token
    ) {
      throw new Error('invalid control configuration');
    }
    return { socketPath: auth.socketPath, token: auth.token };
  } catch {
    // The private filename and JSON contents are both capability-bearing state.
    throw new Error('Invalid private control configuration.');
  }
}

const auth = await loadAuth();

async function call(method: BrokerMethod, params: unknown): Promise<unknown> {
  const timeoutMs =
    method === 'await_dispatches' &&
    params !== null &&
    typeof params === 'object' &&
    typeof (params as { timeoutMs?: unknown }).timeoutMs === 'number'
      ? Math.min(
          3_605_000,
          Math.max(30_000, (params as { timeoutMs: number }).timeoutMs + 5_000),
        )
      : 30_000;
  return callBroker(auth, method, params, { timeoutMs });
}

const server = new McpServer({
  name: 'harness-meta-control',
  version: '1.0.0',
});
const purpose = z.enum([
  'research',
  'plan',
  'implement',
  'test',
  'review',
  'verify',
  'critique',
]);
server.registerTool(
  'dispatch',
  {
    description: 'Delegate bounded work to one configured direct child role.',
    inputSchema: {
      role: z.string().min(1).max(64),
      purpose,
      prompt: z.string().min(1).max(65_536),
      provider: z.enum(['claude_code', 'codex', 'cursor']).optional(),
      model: z.string().max(100).optional(),
    },
  },
  async (params) => ({
    content: [
      { type: 'text', text: JSON.stringify(await call('dispatch', params)) },
    ],
  }),
);
server.registerTool(
  'continue_dispatch',
  {
    description:
      'Continue an owned child dispatch in its existing workspace and provider session.',
    inputSchema: {
      dispatchId: z.string().min(1).max(100),
      prompt: z.string().min(1).max(65_536),
    },
  },
  async (params) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(await call('continue_dispatch', params)),
      },
    ],
  }),
);
server.registerTool(
  'await_dispatches',
  {
    description:
      'Wait for owned dispatches and return bounded summaries and diff metadata.',
    inputSchema: {
      dispatchIds: z.array(z.string().min(1).max(100)).min(1).max(32),
      timeoutMs: z.number().int().min(1).max(3_600_000).optional(),
    },
  },
  async (params) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(await call('await_dispatches', params)),
      },
    ],
  }),
);
server.registerTool(
  'cancel_dispatch',
  {
    description:
      'Interrupt one owned active child dispatch without deleting its workspace.',
    inputSchema: { dispatchId: z.string().min(1).max(100) },
  },
  async (params) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(await call('cancel_dispatch', params)),
      },
    ],
  }),
);
await server.connect(
  new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 512 * 1024,
  }),
);
