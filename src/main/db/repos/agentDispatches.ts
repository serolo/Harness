import { v7 as uuidv7 } from 'uuid';
import { AppError } from '@shared/errors';
import type {
  AgentDispatchPurpose,
  AgentDispatchStatus,
  AgentDispatchSummary,
} from '@shared/agents';
import type { HarnessId } from '@shared/harness';
import type { AppDatabase } from '../index';
import type { AgentDispatchesTable } from '../schema';

function rowToSummary(row: AgentDispatchesTable): AgentDispatchSummary {
  let changedFiles: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.changed_files_json);
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === 'string')
    )
      changedFiles = parsed;
  } catch {
    /* corrupt optional metadata degrades to empty */
  }
  return {
    id: row.id,
    runId: row.run_id,
    parentDispatchId: row.parent_dispatch_id,
    role: row.role,
    purpose: row.purpose,
    childAgentSlug: row.child_agent_slug,
    workspaceId: row.workspace_id,
    branch: row.branch,
    turnId: row.turn_id,
    sessionId: row.session_id,
    harness: row.harness,
    model: row.model,
    status: row.status,
    summary: row.summary,
    changedFiles,
    diffStat: row.diff_stat,
    error: row.error,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    ...(row.debate_stage ? { debateStage: row.debate_stage } : {}),
    ...(row.debate_round !== null ? { debateRound: row.debate_round } : {}),
  };
}

export class AgentDispatchesRepo {
  constructor(private readonly db: AppDatabase) {}
  async create(input: {
    runId: string;
    role: string;
    purpose: AgentDispatchPurpose;
    childAgentSlug: string;
    harness: HarnessId;
    model?: string;
    parentDispatchId?: string;
    debateStage?: 'partner' | 'critique';
    debateRound?: number;
  }): Promise<AgentDispatchSummary> {
    const row: AgentDispatchesTable = {
      id: uuidv7(),
      run_id: input.runId,
      parent_dispatch_id: input.parentDispatchId ?? null,
      role: input.role,
      purpose: input.purpose,
      child_agent_slug: input.childAgentSlug,
      workspace_id: null,
      branch: null,
      turn_id: null,
      session_id: null,
      harness: input.harness,
      model: input.model ?? null,
      status: 'pending',
      summary: null,
      changed_files_json: '[]',
      diff_stat: null,
      error: null,
      created_at: Date.now(),
      started_at: null,
      ended_at: null,
      debate_stage: input.debateStage ?? null,
      debate_round: input.debateRound ?? null,
    };
    await this.db.insertInto('agent_dispatches').values(row).execute();
    return rowToSummary(row);
  }
  async list(runId: string): Promise<AgentDispatchSummary[]> {
    return (
      await this.db
        .selectFrom('agent_dispatches')
        .selectAll()
        .where('run_id', '=', runId)
        .orderBy('created_at', 'asc')
        .execute()
    ).map(rowToSummary);
  }
  async get(id: string): Promise<AgentDispatchSummary> {
    return rowToSummary(await this.requireRow(id));
  }
  async claim(
    id: string,
    workspace: { id: string; branch: string },
    turn: { id?: string; sessionId?: string },
  ): Promise<AgentDispatchSummary> {
    return this.update(id, ['pending'], 'running', {
      workspace_id: workspace.id,
      branch: workspace.branch,
      turn_id: turn.id ?? null,
      session_id: turn.sessionId ?? null,
      started_at: Date.now(),
    });
  }
  async resume(
    id: string,
    turn: { id?: string; sessionId: string },
  ): Promise<AgentDispatchSummary> {
    const existing = await this.requireRow(id);
    if (
      existing.status !== 'running' &&
      existing.status !== 'completed' &&
      existing.status !== 'failed'
    )
      throw new AppError('conflict', 'dispatch is not resumable', { id });
    const set: Partial<AgentDispatchesTable> = {
      status: 'running',
      turn_id: turn.id ?? existing.turn_id,
      session_id: turn.sessionId,
      summary: null,
      changed_files_json: '[]',
      diff_stat: null,
      error: null,
      ended_at: null,
      started_at: Date.now(),
    };
    const result = await this.db
      .updateTable('agent_dispatches')
      .set(set)
      .where('id', '=', id)
      .where('status', 'in', ['running', 'completed', 'failed'])
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n)
      throw new AppError('conflict', 'dispatch changed while resuming', { id });
    return this.get(id);
  }
  async attachTurn(
    id: string,
    turn: { id?: string; sessionId: string },
  ): Promise<AgentDispatchSummary> {
    await this.db
      .updateTable('agent_dispatches')
      .set({
        turn_id: turn.id ?? null,
        session_id: turn.sessionId,
      })
      .where('id', '=', id)
      .where('status', '=', 'running')
      .executeTakeFirst();
    return this.get(id);
  }
  async finish(
    id: string,
    status: Extract<
      AgentDispatchStatus,
      'completed' | 'failed' | 'cancelled' | 'timed_out'
    >,
    result: {
      summary?: string;
      changedFiles?: string[];
      diffStat?: string;
      error?: string;
    } = {},
  ): Promise<AgentDispatchSummary> {
    return this.update(id, ['pending', 'running'], status, {
      summary: result.summary ?? null,
      changed_files_json: JSON.stringify(
        (result.changedFiles ?? []).slice(0, 500),
      ),
      diff_stat: result.diffStat ?? null,
      error: result.error ?? null,
      ended_at: Date.now(),
    });
  }
  async interruptStale(runIds: string[]): Promise<AgentDispatchSummary[]> {
    if (runIds.length === 0) return [];
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('agent_dispatches')
        .selectAll()
        .where('run_id', 'in', runIds)
        .where('status', 'in', ['pending', 'running'])
        .execute();
      const interrupted: AgentDispatchSummary[] = [];
      const endedAt = Date.now();
      for (const row of rows) {
        const next: Partial<AgentDispatchesTable> = {
          status: 'cancelled',
          error: 'application exited while the dispatch was active',
          ended_at: endedAt,
        };
        const result = await trx
          .updateTable('agent_dispatches')
          .set(next)
          .where('id', '=', row.id)
          .where('status', 'in', ['pending', 'running'])
          .executeTakeFirst();
        if (result.numUpdatedRows === 1n)
          interrupted.push(rowToSummary({ ...row, ...next }));
      }
      return interrupted;
    });
  }
  private async update(
    id: string,
    expected: AgentDispatchStatus[],
    status: AgentDispatchStatus,
    set: Partial<AgentDispatchesTable>,
  ): Promise<AgentDispatchSummary> {
    const existing = await this.requireRow(id);
    if (!expected.includes(existing.status)) return rowToSummary(existing);
    const next = { ...set, status };
    const result = await this.db
      .updateTable('agent_dispatches')
      .set(next)
      .where('id', '=', id)
      .where('status', 'in', expected)
      .executeTakeFirst();
    return result.numUpdatedRows === 0n
      ? this.get(id)
      : rowToSummary({ ...existing, ...next });
  }
  private async requireRow(id: string): Promise<AgentDispatchesTable> {
    const row = await this.db
      .selectFrom('agent_dispatches')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row)
      throw new AppError('not_found', 'agent dispatch not found', { id });
    return row;
  }
}
