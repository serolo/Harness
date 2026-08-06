// Test-only deterministic provider seam for the built Electron meta-harness E2E.
// It models a provider invoking the real capability broker while leaving registry,
// IPC, DB, worktree allocation, scheduling, claims, and supervisor lifecycle intact.

import { readFile } from 'node:fs/promises';
import type {
  AgentEvent,
  DetectResult,
  Harness,
  HarnessCapabilities,
  HarnessId,
  StartTurnOpts,
  TurnHandle,
} from '@shared/harness';
import type { AgentDispatchSummary } from '@shared/agents';
import type { StreamSink } from '@shared/ipc';
import { callBroker, type BrokerAuth } from '../meta-harness/proxy-client';

const TWO_CHILDREN_MARKER = 'E2E_META_TWO_CHILDREN';
const HOLD_MARKER = 'E2E_META_HOLD';

function controlAuthPath(opts: StartTurnOpts): string | undefined {
  return opts.mcpConfig.find((server) => server.name === 'harness-meta-control')
    ?.env?.['HARNESS_META_CONTROL_FILE'];
}

async function loadControlAuth(path: string): Promise<BrokerAuth> {
  const parsed = JSON.parse(
    await readFile(path, 'utf8'),
  ) as Partial<BrokerAuth>;
  if (!parsed.socketPath || !parsed.token)
    throw new Error('invalid E2E control configuration');
  return { socketPath: parsed.socketPath, token: parsed.token };
}

async function dispatch(
  auth: BrokerAuth,
  role: string,
  purpose: string,
  prompt: string,
): Promise<AgentDispatchSummary> {
  return (await callBroker(auth, 'dispatch', {
    role,
    purpose,
    prompt,
  })) as AgentDispatchSummary;
}

async function awaitDispatches(
  auth: BrokerAuth,
  dispatchIds: string[],
): Promise<AgentDispatchSummary[]> {
  return (await callBroker(auth, 'await_dispatches', {
    dispatchIds,
    timeoutMs: 10_000,
  })) as AgentDispatchSummary[];
}

async function runPollyScenario(auth: BrokerAuth): Promise<string> {
  const [implementer, investigator] = await Promise.all([
    dispatch(auth, 'implementer', 'implement', 'Implement the E2E slice.'),
    dispatch(auth, 'investigator', 'research', 'Investigate the E2E slice.'),
  ]);
  await awaitDispatches(auth, [implementer.id, investigator.id]);
  await callBroker(auth, 'continue_dispatch', {
    dispatchId: implementer.id,
    prompt: 'Continue in the same child workspace and provider session.',
  });
  await awaitDispatches(auth, [implementer.id]);
  return 'Two isolated children completed and the implementation child continued.';
}

async function runDebbyScenario(auth: BrokerAuth): Promise<string> {
  const partners = await Promise.all([
    dispatch(
      auth,
      'claude-partner',
      'research',
      'Answer independently as Claude.',
    ),
    dispatch(
      auth,
      'codex-partner',
      'research',
      'Answer independently as Codex.',
    ),
  ]);
  const partnerResults = await awaitDispatches(
    auth,
    partners.map((item) => item.id),
  );
  const partnerContext = partnerResults
    .map((item) => `${item.role}: ${item.summary ?? ''}`)
    .join('\n');
  const critics = await Promise.all([
    dispatch(
      auth,
      'claude-critic',
      'critique',
      `Critique the partner answers.\n${partnerContext}`,
    ),
    dispatch(
      auth,
      'codex-critic',
      'critique',
      `Critique the partner answers.\n${partnerContext}`,
    ),
  ]);
  await awaitDispatches(
    auth,
    critics.map((item) => item.id),
  );
  return 'Debby synthesis preserves both partner answers and both critiques.';
}

export class E2EMetaHarness implements Harness {
  constructor(readonly id: HarnessId) {}

  capabilities(): HarnessCapabilities {
    return {
      supportsResume: true,
      supportsMcp: true,
      supportsPlanMode: true,
      rawTerminalFallback: true,
      supportsReadOnlyMode: true,
      supportsReadOnlyMcp: true,
      supportsScopedWriteMode: true,
    };
  }

  async detect(): Promise<DetectResult> {
    return {
      installed: true,
      authenticated: true,
      version: 'e2e-meta-1.0.0',
    };
  }

  startTurn(
    opts: StartTurnOpts,
    sink: StreamSink<AgentEvent>,
  ): Promise<TurnHandle> {
    let finished = false;
    let interrupted = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      sink.end();
    };
    const terminal = (event: AgentEvent): void => {
      if (finished || interrupted) return;
      sink.push(event);
      finish();
    };
    const controlPath = controlAuthPath(opts);

    const run = async (): Promise<void> => {
      if (opts.prompt.includes(HOLD_MARKER) && controlPath) return;
      try {
        let summary = `Working on: ${opts.prompt.trim().slice(0, 160)}`;
        if (controlPath) {
          const auth = await loadControlAuth(controlPath);
          if (opts.prompt.includes(TWO_CHILDREN_MARKER))
            summary = await runPollyScenario(auth);
          else if (
            opts.prompt.includes('claude-partner') &&
            opts.prompt.includes('codex-partner')
          )
            summary = await runDebbyScenario(auth);
        }
        if (finished || interrupted) return;
        sink.push({ kind: 'text', delta: summary });
        terminal({
          kind: 'turn_end',
          usage: { inputTokens: 12, outputTokens: 34 },
        });
      } catch (error) {
        if (finished || interrupted) return;
        terminal({
          kind: 'error',
          message: error instanceof Error ? error.message : 'E2E turn failed',
        });
      }
    };
    setTimeout(() => void run(), 5).unref?.();

    return Promise.resolve({
      sessionId: opts.sessionId ?? `e2e-${this.id}-${crypto.randomUUID()}`,
      interrupt: async () => {
        if (finished) return;
        interrupted = true;
        sink.push({ kind: 'turn_end' });
        finish();
      },
    });
  }
}
