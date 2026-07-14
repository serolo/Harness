// TasksPanel test (Phase 12). Runs under jsdom with a stubbed `window.api` (the only main
// access point), mirroring ChecksPanel.test.tsx so the real `@renderer/ipc` funnel + real
// components run.
//
// Covers: the list renders a state badge per task; a `missed` row shows Reschedule + Run
// now; the create form submits `task:create` with the chosen model; and a `task:changed`
// event triggers a refetch.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { TasksPanel } from './TasksPanel';
import { useTasksStore } from '@renderer/stores/tasks';
import type { ScheduledTask } from '@shared/tasks';

interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
}

function makeTask(over: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 'task-1',
    workspaceId: 'ws1',
    prompt: 'do the thing',
    model: null,
    mode: null,
    scheduledAt: null,
    state: 'pending',
    origin: 'user',
    turnId: null,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const TASKS: ScheduledTask[] = [
  makeTask({ id: 'a', state: 'scheduled', scheduledAt: Date.now() + 60_000 }),
  makeTask({ id: 'b', state: 'missed', prompt: 'was missed' }),
];

interface Installed {
  api: ApiStub;
  listeners: Record<string, ((payload: unknown) => void)[]>;
  unsubscribe: ReturnType<typeof vi.fn>;
}

function installApi(tasks: ScheduledTask[]): Installed {
  const listeners: Record<string, ((payload: unknown) => void)[]> = {};
  const unsubscribe = vi.fn();

  const invoke = vi.fn((channel: string) => {
    switch (channel) {
      case 'task:list':
        return Promise.resolve(tasks);
      case 'settings:getEffective':
        return Promise.resolve({ agent: { mode: 'default' } });
      case 'task:create':
      case 'task:update':
        return Promise.resolve(makeTask({}));
      case 'task:runNow':
      case 'task:markDone':
        return Promise.resolve(makeTask({}));
      case 'task:delete':
        return Promise.resolve(undefined);
      default:
        return Promise.resolve(undefined);
    }
  });

  const api: ApiStub = {
    invoke,
    on: vi.fn((event: string, cb: (payload: unknown) => void) => {
      (listeners[event] ??= []).push(cb);
      return unsubscribe;
    }),
    stream: vi.fn(() => Promise.resolve()),
  };
  (window as unknown as { api: ApiStub }).api = api;
  return { api, listeners, unsubscribe };
}

beforeEach(() => {
  useTasksStore.setState({ tasksByWorkspace: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('TasksPanel rendering', () => {
  it('renders a state badge per task', async () => {
    installApi(TASKS);
    render(<TasksPanel workspaceId="ws1" />);

    expect(
      await screen.findByTestId('task-state-scheduled'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('task-state-missed')).toBeInTheDocument();
  });

  it('shows Reschedule + Run now on a missed task', async () => {
    installApi(TASKS);
    render(<TasksPanel workspaceId="ws1" />);

    expect(await screen.findByTestId('task-reschedule-b')).toBeInTheDocument();
    expect(screen.getByTestId('task-run-b')).toBeInTheDocument();
  });
});

describe('TasksPanel create form', () => {
  it('submits task:create with the chosen model', async () => {
    const { api } = installApi([]);
    render(<TasksPanel workspaceId="ws1" />);

    // Open the form.
    fireEvent.click(await screen.findByTestId('task-new'));

    // Fill the prompt + pick a model preset.
    fireEvent.change(screen.getByTestId('task-prompt'), {
      target: { value: 'run the suite' },
    });
    fireEvent.change(screen.getByTestId('task-model-select'), {
      target: { value: 'sonnet' },
    });

    fireEvent.click(screen.getByTestId('task-form-submit'));

    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith(
        'task:create',
        expect.objectContaining({
          workspaceId: 'ws1',
          prompt: 'run the suite',
          model: 'sonnet',
        }),
      ),
    );
  });
});

describe('TasksPanel task:changed subscription', () => {
  it('refetches when a task:changed event fires for this workspace', async () => {
    const { api, listeners } = installApi(TASKS);
    render(<TasksPanel workspaceId="ws1" />);

    await screen.findByTestId('task-state-scheduled');
    const before = api.invoke.mock.calls.filter(
      (c) => c[0] === 'task:list',
    ).length;

    listeners['task:changed']?.forEach((cb) => cb({ workspaceId: 'ws1' }));

    await waitFor(() => {
      const after = api.invoke.mock.calls.filter(
        (c) => c[0] === 'task:list',
      ).length;
      expect(after).toBeGreaterThan(before);
    });
  });
});
