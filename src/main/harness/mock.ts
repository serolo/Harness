// MockHarness (phase-doc §3.9) — a deterministic, config-driven `Harness` that emits
// scripted `AgentEvent` sequences with timing, WITHOUT spawning a real `claude` CLI.
// It drives every renderer/E2E test and the whole app under `AGENTAPP_MOCK_HARNESS=1`
// / `AGENTAPP_E2E=1`, so CI never depends on an installed CLI.
//
// Per Open Decision D2 it reuses the frozen id `'claude_code'` (selected via
// settings/env, not a new HarnessId) so a `claude_code` workspace transparently runs
// the mock. It honors the same contract as the real adapter: resolves a `TurnHandle`
// with a session id, streams events into the sink, emits a terminal `turn_end` on
// interrupt, and echoes the resume session id so `--resume` behaviour is observable.

import type {
  AgentEvent,
  DetectResult,
  Harness,
  HarnessCapabilities,
  StartTurnOpts,
  SteerableTurnHandle,
  SteerResult,
  TurnHandle,
} from '@shared/harness';
import type { StreamSink } from '@shared/ipc';

/** One scripted step: an event and the delay (ms) BEFORE it is emitted. */
export interface MockScriptStep {
  event: AgentEvent;
  delayMs?: number;
}

export interface MockHarnessOptions {
  /**
   * Build the scripted steps for a turn. Defaults to a small text stream echoing the
   * prompt, a todo update, and a clean `turn_end`. The final step SHOULD be a terminal
   * event (`turn_end`/`error`); the mock appends one if the script omits it.
   */
  script?: (opts: StartTurnOpts) => MockScriptStep[];
  /** Default per-step delay when a step doesn't specify one. `0` = synchronous-ish (tests). */
  defaultDelayMs?: number;
  /** Version reported by `detect()`. */
  version?: string;
  /**
   * When true, `capabilities().supportsMidTurnSteer` is true and `startTurn` resolves a
   * `SteerableTurnHandle` whose `steer(text)` injects a scripted event into the SAME live
   * sink and resolves `'injected'`. This is the ONLY way Phase-9 tests exercise the
   * true-injection path (no shipped adapter is steerable). Defaults to false.
   */
  steerable?: boolean;
}

/** Default script: stream a few text deltas from the prompt, a todo, then end. */
function defaultScript(opts: StartTurnOpts): MockScriptStep[] {
  const words = opts.prompt.trim().split(/\s+/).filter(Boolean).slice(0, 6);
  const textSteps: MockScriptStep[] = words.map((w, i) => ({
    event: { kind: 'text', delta: (i === 0 ? '' : ' ') + w },
  }));
  return [
    { event: { kind: 'text', delta: 'Working on: ' } },
    ...textSteps,
    {
      event: {
        kind: 'todo_update',
        todos: [
          {
            id: '1',
            body: 'Understand the request',
            done: true,
            source: 'agent',
          },
          { id: '2', body: 'Apply the change', done: false, source: 'agent' },
        ],
      },
    },
    {
      event: { kind: 'turn_end', usage: { inputTokens: 12, outputTokens: 34 } },
    },
  ];
}

export class MockHarness implements Harness {
  readonly id = 'claude_code' as const;
  private turnCounter = 0;
  private readonly opts: Required<Omit<MockHarnessOptions, 'script'>> &
    Pick<MockHarnessOptions, 'script'>;

  constructor(options: MockHarnessOptions = {}) {
    this.opts = {
      script: options.script,
      defaultDelayMs: options.defaultDelayMs ?? 5,
      version: options.version ?? 'mock-1.0.0',
      steerable: options.steerable ?? false,
    };
  }

  capabilities(): HarnessCapabilities {
    return {
      supportsResume: true,
      supportsMcp: true,
      supportsPlanMode: true,
      rawTerminalFallback: true,
      supportsMidTurnSteer: this.opts.steerable,
    };
  }

  async detect(): Promise<DetectResult> {
    return { installed: true, version: this.opts.version, authenticated: true };
  }

  startTurn(
    opts: StartTurnOpts,
    sink: StreamSink<AgentEvent>,
  ): Promise<TurnHandle> {
    // Echo the resume session id so resume is observable; otherwise mint a
    // deterministic one per turn.
    const sessionId = opts.sessionId ?? `mock-session-${++this.turnCounter}`;

    const steps = (this.opts.script ?? defaultScript)(opts);
    // Guarantee a terminal event so the turn (and its recorder row) always closes.
    const hasTerminal = steps.some(
      (s) => s.event.kind === 'turn_end' || s.event.kind === 'error',
    );
    const script = hasTerminal
      ? steps
      : [...steps, { event: { kind: 'turn_end' } as AgentEvent }];

    let index = 0;
    let interrupted = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      sink.end();
    };

    const emitNext = (): void => {
      if (finished) return;
      if (interrupted) {
        // Interrupt: emit a single terminal turn_end then end (the supervisor maps
        // this to an `interrupted` turn because IT initiated the interrupt).
        sink.push({ kind: 'turn_end' });
        finish();
        return;
      }
      if (index >= script.length) {
        finish();
        return;
      }
      const step = script[index++];
      sink.push(step.event);
      if (step.event.kind === 'turn_end' || step.event.kind === 'error') {
        finish();
        return;
      }
      const delay = step.delayMs ?? this.opts.defaultDelayMs;
      timer = setTimeout(emitNext, delay);
    };

    const interrupt = async (): Promise<void> => {
      interrupted = true;
      if (timer) clearTimeout(timer);
      // Emit the terminal event promptly on the next tick.
      timer = setTimeout(emitNext, 0);
    };

    // Kick the script asynchronously so the caller has the handle before events flow.
    timer = setTimeout(emitNext, this.opts.defaultDelayMs);

    if (!this.opts.steerable) {
      return Promise.resolve({ sessionId, interrupt });
    }

    // Steerable mode: inject a scripted marker event into the SAME live sink (true
    // mid-turn injection — no new stream). Guard against pushing after the turn ended.
    const steer = async (text: string): Promise<SteerResult> => {
      if (finished || interrupted) return 'rejected';
      sink.push({ kind: 'text', delta: `\n[steered] ${text}` });
      return 'injected';
    };

    const steerable: SteerableTurnHandle = { sessionId, interrupt, steer };
    return Promise.resolve(steerable);
  }
}
