// useQueueStore (Phase 9) — the renderer-side, DB-backed follow-up message queue. Runs
// under jsdom with a stubbed `window.api` (the only main-process access point), mirroring
// harness.test.ts. Because every mutation round-trips through `queue:*` and then re-`load`s
// via `queue:list`, the stub routes those commands to a mutable in-memory backing store
// that behaves like the real repo (append at tail, list head-first by orderIdx, reorder
// rewrites 0..n-1). That lets us assert the CACHE reflects the SERVER-authoritative order
// after each action — not an optimistic client guess.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { QueuedMessage } from '@shared/queue';
import { useQueueStore } from './queue';

interface ApiStub {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
}

/**
 * A tiny in-memory fake of the `queued_messages` table + repo, exposed as a `queue:*`
 * command router. `orderIdx` is authoritative: `enqueue` appends at the tail, `list`
 * returns head-first, `reorder` rewrites 0..n-1 in the given order.
 */
function installApi(): { api: ApiStub; rows: QueuedMessage[] } {
  const rows: QueuedMessage[] = [];
  let idSeq = 0;

  const sortedFor = (workspaceId: string): QueuedMessage[] =>
    rows
      .filter((r) => r.workspaceId === workspaceId)
      .sort((a, b) => a.orderIdx - b.orderIdx)
      .map((r) => ({ ...r }));

  const invoke = vi.fn((channel: string, req: unknown) => {
    switch (channel) {
      case 'queue:list': {
        const { workspaceId } = req as { workspaceId: string };
        return Promise.resolve(sortedFor(workspaceId));
      }
      case 'queue:enqueue': {
        const r = req as {
          workspaceId: string;
          prompt: string;
          attachments: QueuedMessage['attachments'];
          mode?: QueuedMessage['mode'];
        };
        const maxIdx = rows
          .filter((x) => x.workspaceId === r.workspaceId)
          .reduce((m, x) => Math.max(m, x.orderIdx), -1);
        const created: QueuedMessage = {
          id: `q${++idSeq}`,
          workspaceId: r.workspaceId,
          prompt: r.prompt,
          attachments: r.attachments,
          mode: r.mode,
          orderIdx: maxIdx + 1,
          createdAt: idSeq,
        };
        rows.push(created);
        return Promise.resolve({ ...created });
      }
      case 'queue:update': {
        const { id, ...patch } = req as {
          id: string;
          prompt?: string;
          attachments?: QueuedMessage['attachments'];
          mode?: QueuedMessage['mode'];
        };
        const row = rows.find((x) => x.id === id);
        if (!row) return Promise.reject(new Error('not found'));
        if (patch.prompt !== undefined) row.prompt = patch.prompt;
        if (patch.attachments !== undefined)
          row.attachments = patch.attachments;
        if ('mode' in patch) row.mode = patch.mode;
        return Promise.resolve({ ...row });
      }
      case 'queue:reorder': {
        const { orderedIds } = req as {
          workspaceId: string;
          orderedIds: string[];
        };
        orderedIds.forEach((id, i) => {
          const row = rows.find((x) => x.id === id);
          if (row) row.orderIdx = i;
        });
        return Promise.resolve(undefined);
      }
      case 'queue:remove': {
        const { id } = req as { id: string };
        const i = rows.findIndex((x) => x.id === id);
        if (i >= 0) rows.splice(i, 1);
        return Promise.resolve(undefined);
      }
      default:
        return Promise.resolve(undefined);
    }
  });

  const api: ApiStub = {
    invoke,
    on: vi.fn(() => () => {}),
    stream: vi.fn(() => Promise.resolve()),
  };
  (window as unknown as { api: ApiStub }).api = api;
  return { api, rows };
}

const WS = 'ws1';

beforeEach(() => {
  useQueueStore.setState({ byWorkspace: {} });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('useQueueStore.load', () => {
  it('populates byWorkspace from queue:list', async () => {
    const { rows } = installApi();
    rows.push(
      {
        id: 'a',
        workspaceId: WS,
        prompt: 'a',
        attachments: [],
        orderIdx: 0,
        createdAt: 1,
      },
      {
        id: 'b',
        workspaceId: WS,
        prompt: 'b',
        attachments: [],
        orderIdx: 1,
        createdAt: 2,
      },
    );

    await useQueueStore.getState().load(WS);

    expect(
      useQueueStore.getState().byWorkspace[WS].map((m) => m.prompt),
    ).toEqual(['a', 'b']);
  });

  it('degrades gracefully on a list failure (keeps last-known cache)', async () => {
    const { api } = installApi();
    // Seed a known cache, then make the next list reject.
    useQueueStore.setState({
      byWorkspace: {
        [WS]: [
          {
            id: 'a',
            workspaceId: WS,
            prompt: 'kept',
            attachments: [],
            orderIdx: 0,
            createdAt: 1,
          },
        ],
      },
    });
    api.invoke.mockRejectedValueOnce(new Error('boom'));

    await useQueueStore.getState().load(WS);

    expect(
      useQueueStore.getState().byWorkspace[WS].map((m) => m.prompt),
    ).toEqual(['kept']);
  });
});

describe('useQueueStore.enqueue', () => {
  it('calls queue:enqueue then re-loads, reflecting head-first server order', async () => {
    const { api } = installApi();

    await useQueueStore.getState().enqueue(WS, 'first', []);
    await useQueueStore.getState().enqueue(WS, 'second', [], 'plan');

    expect(api.invoke).toHaveBeenCalledWith('queue:enqueue', {
      workspaceId: WS,
      prompt: 'first',
      attachments: [],
      mode: undefined,
    });
    // Cache reflects the DB order (head first), assigned by the server.
    const cached = useQueueStore.getState().byWorkspace[WS];
    expect(cached.map((m) => m.prompt)).toEqual(['first', 'second']);
    expect(cached.map((m) => m.orderIdx)).toEqual([0, 1]);
    expect(cached[1].mode).toBe('plan');
  });
});

describe('useQueueStore.reorder', () => {
  it('sends queue:reorder and reflects the new authoritative order', async () => {
    const { api } = installApi();
    await useQueueStore.getState().enqueue(WS, 'a', []);
    await useQueueStore.getState().enqueue(WS, 'b', []);
    await useQueueStore.getState().enqueue(WS, 'c', []);
    const ids = useQueueStore.getState().byWorkspace[WS].map((m) => m.id);

    // Reverse.
    await useQueueStore.getState().reorder(WS, [ids[2], ids[1], ids[0]]);

    expect(api.invoke).toHaveBeenCalledWith('queue:reorder', {
      workspaceId: WS,
      orderedIds: [ids[2], ids[1], ids[0]],
    });
    const cached = useQueueStore.getState().byWorkspace[WS];
    expect(cached.map((m) => m.prompt)).toEqual(['c', 'b', 'a']);
    // Head is index 0 — the auto-flush-on-idle contract (head sends first).
    expect(cached[0].prompt).toBe('c');
    expect(cached.map((m) => m.orderIdx)).toEqual([0, 1, 2]);
  });
});

describe('useQueueStore.update', () => {
  it('sends queue:update and re-loads from the response workspace', async () => {
    const { api } = installApi();
    await useQueueStore.getState().enqueue(WS, 'original', []);
    const id = useQueueStore.getState().byWorkspace[WS][0].id;

    await useQueueStore.getState().update(id, { prompt: 'edited' });

    expect(api.invoke).toHaveBeenCalledWith('queue:update', {
      id,
      prompt: 'edited',
    });
    expect(useQueueStore.getState().byWorkspace[WS][0].prompt).toBe('edited');
  });
});

describe('useQueueStore.remove', () => {
  it('sends queue:remove and re-loads, draining the removed head', async () => {
    const { api } = installApi();
    await useQueueStore.getState().enqueue(WS, 'a', []);
    await useQueueStore.getState().enqueue(WS, 'b', []);
    const headId = useQueueStore.getState().byWorkspace[WS][0].id;

    await useQueueStore.getState().remove(WS, headId);

    expect(api.invoke).toHaveBeenCalledWith('queue:remove', { id: headId });
    expect(
      useQueueStore.getState().byWorkspace[WS].map((m) => m.prompt),
    ).toEqual(['b']);
  });
});
