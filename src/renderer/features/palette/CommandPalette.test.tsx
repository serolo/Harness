// CommandPalette tests (Phase 6, Track H2). Exercises the pure fuzzy matcher/registry and
// the palette overlay: it filters as you type, runs the highlighted command on Enter,
// closes on Escape/backdrop, and lists per-workspace switch commands. Runs under jsdom
// against the REAL zustand stores (reset between tests) and a mock CommandActions.

import { describe, it, expect, afterEach, vi, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { CommandPalette } from './CommandPalette';
import {
  fuzzyScore,
  filterCommands,
  type Command,
  type CommandActions,
} from './useCommands';
import { useUiStore } from '@renderer/stores/ui';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import type { Workspace } from '@shared/models';

function ws(id: string, name: string): Workspace {
  return {
    id,
    projectId: 'p1',
    name,
    branch: `agent/${name}`,
    baseBranch: 'main',
    worktreePath: `/tmp/${name}`,
    status: 'idle',
    sourceKind: null,
    sourceRef: null,
    harness: 'claude_code',
    port: null,
    createdAt: 0,
    archivedAt: null,
    prNumber: null,
  };
}

type MockCommandActions = CommandActions & {
  [K in keyof CommandActions]: Mock<CommandActions[K]>;
};

function makeActions(): MockCommandActions {
  return {
    showPane: vi.fn<CommandActions['showPane']>(),
    openSettings: vi.fn<CommandActions['openSettings']>(),
    newWorkspace: vi.fn<CommandActions['newWorkspace']>(),
    openPr: vi.fn<CommandActions['openPr']>(),
    selectWorkspace: vi.fn<CommandActions['selectWorkspace']>(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  useUiStore.setState({ paletteOpen: false, newWorkspaceOpen: false });
  useWorkspacesStore.setState({
    workspaces: [],
    projects: [],
    selectedProjectId: null,
    selectedWorkspaceId: null,
  });
});

describe('fuzzy matching', () => {
  it('scores a subsequence and rejects a non-subsequence', () => {
    expect(fuzzyScore('sdiff', 'Show Diff')).not.toBeNull();
    expect(fuzzyScore('xyz', 'Show Diff')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(1);
  });

  it('ranks a closer match above a looser one', () => {
    const commands: Command[] = [
      { id: 'a', title: 'Show Diff', run: () => {} },
      { id: 'b', title: 'Show Terminal', run: () => {} },
    ];
    const ranked = filterCommands(commands, 'diff');
    expect(ranked[0]?.id).toBe('a');
  });

  it('drops non-matching commands and keeps all on empty query', () => {
    const commands: Command[] = [
      { id: 'a', title: 'Settings', run: () => {} },
      { id: 'b', title: 'Open Pull Request', keywords: 'pr', run: () => {} },
    ];
    expect(filterCommands(commands, 'pr').map((c) => c.id)).toEqual(['b']);
    expect(filterCommands(commands, '')).toHaveLength(2);
  });
});

describe('CommandPalette overlay', () => {
  it('renders nothing when closed', () => {
    render(<CommandPalette actions={makeActions()} />);
    expect(screen.queryByTestId('command-palette')).toBeNull();
  });

  it('filters as you type and runs the highlighted command on Enter', async () => {
    const actions = makeActions();
    useUiStore.getState().setPaletteOpen(true);
    render(<CommandPalette actions={actions} />);

    const input = await screen.findByTestId('command-palette-input');
    fireEvent.change(input, { target: { value: 'settings' } });

    await waitFor(() =>
      expect(screen.getByTestId('command-item-openSettings')).toBeTruthy(),
    );
    // The Diff command should have been filtered out.
    expect(screen.queryByTestId('command-item-showDiff')).toBeNull();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(actions.openSettings).toHaveBeenCalledTimes(1);
    // Running a command closes the palette.
    expect(useUiStore.getState().paletteOpen).toBe(false);
  });

  it('closes on Escape without running a command', async () => {
    const actions = makeActions();
    useUiStore.getState().setPaletteOpen(true);
    render(<CommandPalette actions={actions} />);

    const input = await screen.findByTestId('command-palette-input');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(useUiStore.getState().paletteOpen).toBe(false);
    expect(actions.openSettings).not.toHaveBeenCalled();
  });

  it('lists a switch command per live workspace and runs it', async () => {
    const actions = makeActions();
    useWorkspacesStore.setState({
      workspaces: [ws('w1', 'paris'), ws('w2', 'tokyo')],
      selectedProjectId: 'p1',
    });
    useUiStore.getState().setPaletteOpen(true);
    render(<CommandPalette actions={actions} />);

    const input = await screen.findByTestId('command-palette-input');
    fireEvent.change(input, { target: { value: 'tokyo' } });
    const item = await screen.findByTestId('command-item-selectWorkspace:w2');
    fireEvent.click(item);
    expect(actions.selectWorkspace).toHaveBeenCalledWith('w2');
  });
});
