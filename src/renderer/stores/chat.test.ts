import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/harness';
import { useChatStore } from './chat';

beforeEach(() => {
  useChatStore.setState({
    byWorkspace: {},
    busyByWorkspace: {},
    taskTurnsByWorkspace: {},
  });
});

describe('useChatStore knowledge proposal ingestion', () => {
  it('appends the same live reconciliation event only once', () => {
    const store = useChatStore.getState();
    store.startTurn('ws1', 'turn-1', 'session-1');
    const proposal: AgentEvent = {
      kind: 'knowledge_proposal',
      projectId: 'project-1',
      proposalIds: ['proposal-1'],
    };

    store.appendEvent('ws1', proposal);
    store.appendEvent('ws1', structuredClone(proposal));

    expect(
      useChatStore
        .getState()
        .byWorkspace.ws1?.[0]?.events.filter(
          (event) => event.kind === 'knowledge_proposal',
        ),
    ).toEqual([proposal]);
  });

  it('keeps distinct reconciliation batches', () => {
    const store = useChatStore.getState();
    store.startTurn('ws1', 'turn-1', 'session-1');

    store.appendEvent('ws1', {
      kind: 'knowledge_proposal',
      projectId: 'project-1',
      proposalIds: ['proposal-1'],
    });
    store.appendEvent('ws1', {
      kind: 'knowledge_proposal',
      projectId: 'project-1',
      proposalIds: ['proposal-2'],
    });

    expect(
      useChatStore
        .getState()
        .byWorkspace.ws1?.[0]?.events.filter(
          (event) => event.kind === 'knowledge_proposal',
        ),
    ).toHaveLength(2);
  });
});

describe('useChatStore scheduled turn isolation', () => {
  it('claims a task turn atomically without replacing a pending chat turn', () => {
    const store = useChatStore.getState();
    store.startTurn('ws1', 'pending:chat', '', {
      kind: 'user_message',
      text: 'Current chat prompt',
    });

    store.startTaskTurn(
      'ws1',
      'task-1',
      'turn-task-1',
      'session-task-1',
      'Scheduled prompt',
    );

    const state = useChatStore.getState();
    expect(state.byWorkspace.ws1?.map((turn) => turn.turnId)).toEqual([
      'pending:chat',
      'turn-task-1',
    ]);
    expect(state.taskTurnsByWorkspace.ws1?.['turn-task-1']).toEqual({
      taskId: 'task-1',
      prompt: 'Scheduled prompt',
    });
  });

  it('routes scheduled events to their turn instead of the latest turn', () => {
    const store = useChatStore.getState();
    store.startTaskTurn(
      'ws1',
      'task-1',
      'turn-task-1',
      'session-task-1',
      'Scheduled prompt',
    );
    store.startTurn('ws1', 'turn-chat-2', 'session-chat-2', {
      kind: 'user_message',
      text: 'Later chat prompt',
    });

    store.appendEvent(
      'ws1',
      { kind: 'text', delta: 'Scheduled response' },
      'turn-task-1',
    );
    store.endTurn(
      'ws1',
      'completed',
      { inputTokens: 10, outputTokens: 2 },
      undefined,
      undefined,
      'turn-task-1',
    );

    const [taskTurn, chatTurn] = useChatStore.getState().byWorkspace.ws1 ?? [];
    expect(taskTurn.events).toContainEqual({
      kind: 'text',
      delta: 'Scheduled response',
    });
    expect(taskTurn.status).toBe('completed');
    expect(chatTurn.events).not.toContainEqual({
      kind: 'text',
      delta: 'Scheduled response',
    });
    expect(chatTurn.status).toBe('streaming');
  });

  it('does not duplicate a task turn when its start event is replayed', () => {
    const store = useChatStore.getState();
    store.startTaskTurn(
      'ws1',
      'task-1',
      'turn-task-1',
      'session-task-1',
      'Scheduled prompt',
    );
    store.startTaskTurn(
      'ws1',
      'task-1',
      'turn-task-1',
      'session-task-1',
      'Scheduled prompt',
    );

    expect(useChatStore.getState().byWorkspace.ws1).toHaveLength(1);
    expect(useChatStore.getState().byWorkspace.ws1?.[0]?.events).toEqual([
      { kind: 'user_message', text: 'Scheduled prompt' },
    ]);
  });
});
