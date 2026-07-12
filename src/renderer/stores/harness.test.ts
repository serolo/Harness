// Harness store (Phase 7, Task 4): the single centralized read of per-harness
// capabilities, plus the acceptance proof that capability flags — not a hardcoded harness
// id — drive the composer's Plan-mode gate per SELECTED workspace. Runs under jsdom with a
// stubbed `window.api` (the only main-process access point), mirroring ChatPanel.test.tsx.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import type { HarnessId } from '@shared/harness';
import type { HarnessInfo } from '@shared/ipc';
import type { Workspace } from '@shared/models';
import { useHarnessStore } from './harness';
import { useWorkspacesStore } from './workspaces';
import { Composer } from '@renderer/features/chat/Composer';

/** All three Phase-7 harnesses with distinct plan-mode support. */
const HARNESS_LIST: HarnessInfo[] = [
  {
    id: 'claude_code',
    capabilities: {
      supportsResume: true,
      supportsMcp: true,
      supportsPlanMode: true,
      rawTerminalFallback: true,
      supportsMidTurnSteer: false,
    },
    detect: { installed: true, authenticated: true },
  },
  {
    id: 'codex',
    capabilities: {
      supportsResume: true,
      supportsMcp: false,
      supportsPlanMode: false,
      rawTerminalFallback: false,
      supportsMidTurnSteer: false,
    },
    detect: { installed: true, authenticated: true },
  },
  {
    id: 'cursor',
    capabilities: {
      supportsResume: false,
      supportsMcp: false,
      supportsPlanMode: false,
      rawTerminalFallback: true,
      supportsMidTurnSteer: false,
    },
    detect: { installed: true, authenticated: true },
  },
];

interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
}

/** Install a `window.api` whose `harness:list` resolves (or rejects, when `fail`). */
function installApi(opts: { fail?: boolean } = {}): ApiStub {
  const invoke = vi.fn((channel: string) => {
    if (channel === 'harness:list') {
      return opts.fail
        ? Promise.reject(new Error('detect failed'))
        : Promise.resolve(HARNESS_LIST);
    }
    if (channel === 'slash:list') return Promise.resolve([]);
    if (channel === 'github:listIssues') {
      return Promise.resolve([
        {
          number: 7,
          title: 'Crash on boot',
          url: 'https://github.com/acme/repo/issues/7',
          state: 'open',
        },
      ]);
    }
    if (channel === 'linear:listIssues') return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
  const api: ApiStub = {
    invoke,
    on: vi.fn(() => () => {}),
    stream: vi.fn(() => Promise.resolve()),
  };
  (window as unknown as { api: ApiStub }).api = api;
  return api;
}

function makeWorkspace(harness: HarnessId): Workspace {
  return {
    id: 'ws1',
    projectId: 'p1',
    name: 'athens',
    branch: 'agent/athens',
    baseBranch: 'main',
    worktreePath: '/tmp/ws',
    status: 'idle',
    sourceKind: null,
    sourceRef: null,
    harness,
    port: null,
    createdAt: 0,
    archivedAt: null,
    prNumber: null,
  };
}

beforeEach(() => {
  useHarnessStore.setState({ infoById: {}, loaded: false, loading: false });
  useWorkspacesStore.setState({
    projects: [],
    workspaces: [],
    selectedWorkspaceId: null,
    selectedProjectId: null,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('useHarnessStore', () => {
  it('capabilitiesFor is undefined before load', () => {
    expect(
      useHarnessStore.getState().capabilitiesFor('claude_code'),
    ).toBeUndefined();
  });

  it('capabilitiesFor returns the right flags per id after load', async () => {
    installApi();
    await useHarnessStore.getState().load();

    const capsFor = useHarnessStore.getState().capabilitiesFor;
    expect(capsFor('claude_code')?.supportsPlanMode).toBe(true);
    expect(capsFor('codex')?.supportsPlanMode).toBe(false);
    expect(capsFor('cursor')?.supportsPlanMode).toBe(false);
    expect(capsFor('cursor')?.rawTerminalFallback).toBe(true);
    expect(useHarnessStore.getState().loaded).toBe(true);
  });

  it('load fetches harness:list at most once (idempotent)', async () => {
    const api = installApi();
    await useHarnessStore.getState().load();
    await useHarnessStore.getState().load();
    const listCalls = api.invoke.mock.calls.filter(
      (c) => c[0] === 'harness:list',
    );
    expect(listCalls).toHaveLength(1);
  });

  it('degrades gracefully on error (stays unloaded + retryable)', async () => {
    installApi({ fail: true });
    await useHarnessStore.getState().load();

    const state = useHarnessStore.getState();
    expect(state.loaded).toBe(false);
    expect(state.loading).toBe(false);
    expect(state.capabilitiesFor('claude_code')).toBeUndefined();
  });
});

describe('Composer plan-mode gate (capability-driven, per selected workspace)', () => {
  /** Render the composer for a workspace on `harness`; returns its plan button. */
  async function renderComposerFor(harness: HarnessId): Promise<HTMLElement> {
    installApi();
    useWorkspacesStore.setState({
      projects: [
        {
          id: 'p1',
          name: 'repo',
          originUrl: 'git@github.com:acme/repo.git',
          defaultBranch: 'main',
          repoPath: '/tmp/repo',
          createdAt: 0,
        },
      ],
      workspaces: [makeWorkspace(harness)],
      selectedWorkspaceId: 'ws1',
      selectedProjectId: 'p1',
    });
    render(
      React.createElement(Composer, {
        isBusy: false,
        onSend: () => {},
        onInterrupt: () => {},
      }),
    );
    return screen.findByTestId('composer-plan');
  }

  it('enables Plan when the selected harness supports it (claude_code)', async () => {
    const plan = await renderComposerFor('claude_code');
    await waitFor(() => expect(plan).not.toBeDisabled());
    fireEvent.click(plan);
    expect(plan).toHaveAttribute('aria-pressed', 'true');
  });

  it('disables Plan when the selected harness lacks it (codex)', async () => {
    const plan = await renderComposerFor('codex');
    await waitFor(() => expect(plan).toBeDisabled());
  });

  it('disables Plan for cursor (all structured flags false)', async () => {
    const plan = await renderComposerFor('cursor');
    await waitFor(() => expect(plan).toBeDisabled());
  });

  it('lists runnable models from harness:list', async () => {
    await renderComposerFor('claude_code');
    fireEvent.click(await screen.findByTestId('composer-model'));

    expect(
      await screen.findByTestId('composer-model-menu'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('composer-model-claude_code')).toHaveTextContent(
      'Claude Code',
    );
    expect(screen.getByTestId('composer-model-codex')).toHaveTextContent(
      'Codex',
    );
    expect(screen.getByTestId('composer-model-cursor')).toHaveTextContent(
      'Cursor',
    );
  });

  it('closes the model menu when pressing outside it', async () => {
    await renderComposerFor('claude_code');
    fireEvent.click(await screen.findByTestId('composer-model'));

    expect(await screen.findByTestId('composer-model-menu')).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    await waitFor(() =>
      expect(screen.queryByTestId('composer-model-menu')).not.toBeInTheDocument(),
    );
  });

  it('lets Claude workspaces choose the full effort range', async () => {
    await renderComposerFor('claude_code');
    fireEvent.click(await screen.findByTestId('composer-effort'));

    expect(await screen.findByTestId('composer-effort-menu')).toBeInTheDocument();
    expect(screen.getByTestId('composer-effort-low')).toHaveTextContent('Low');
    expect(screen.getByTestId('composer-effort-max')).toHaveTextContent('Max');

    fireEvent.click(screen.getByTestId('composer-effort-low'));

    expect(screen.getByTestId('composer-effort')).toHaveTextContent('Low');
  });

  it('uses Codex effort levels for Codex workspaces', async () => {
    await renderComposerFor('codex');
    fireEvent.click(await screen.findByTestId('composer-effort'));

    expect(await screen.findByTestId('composer-effort-menu')).toBeInTheDocument();
    expect(screen.getByTestId('composer-effort-medium')).toHaveTextContent(
      'Medium',
    );
    expect(screen.getByTestId('composer-effort-xhigh')).toHaveTextContent(
      'Extra High',
    );
    expect(screen.queryByTestId('composer-effort-max')).not.toBeInTheDocument();
  });

  it('adds file attachments from the plus menu', async () => {
    await renderComposerFor('claude_code');
    fireEvent.click(await screen.findByTestId('composer-plus'));
    fireEvent.click(await screen.findByTestId('composer-plus-attachment'));
    fireEvent.change(await screen.findByTestId('composer-plus-attach-input'), {
      target: { value: 'src/app.ts' },
    });
    fireEvent.click(screen.getByTestId('composer-plus-attach-add'));

    expect(await screen.findByTestId('attachment-bar')).toHaveTextContent(
      'src/app.ts',
    );
  });

  it('links issues from the plus menu into the draft', async () => {
    await renderComposerFor('claude_code');
    fireEvent.click(await screen.findByTestId('composer-plus'));
    fireEvent.click(await screen.findByTestId('composer-plus-issue'));
    fireEvent.click(await screen.findByTestId('composer-issue-github-7'));

    expect(
      (screen.getByTestId('composer-input') as HTMLTextAreaElement).value,
    ).toContain('GitHub issue #7 - Crash on boot');
  });

  it('links workspaces from the plus menu into the draft', async () => {
    await renderComposerFor('claude_code');
    fireEvent.click(await screen.findByTestId('composer-plus'));
    fireEvent.click(await screen.findByTestId('composer-plus-workspaces'));
    fireEvent.click(await screen.findByTestId('composer-workspace-ws1'));

    expect(
      (screen.getByTestId('composer-input') as HTMLTextAreaElement).value,
    ).toContain('Context: workspace athens');
  });
});
