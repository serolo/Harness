import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { AppError } from '@shared/errors';
import {
  type MetaRunStatus,
  type MetaRunSummary,
  type MetaSkillUsageReport,
  type NormalizedAgentSnapshot,
} from '@shared/agents';
import { parseStoredAgentSnapshot } from '../../agents/snapshot';
import {
  parseStoredSkillUsage,
  serializeSkillUsage,
} from '../../meta-harness/skillEvidence';
import type { AppDatabase } from '../index';
import type { AgentRunsTable } from '../schema';

export interface CreateAgentRunInput {
  projectId: string;
  sourceWorkspaceId: string;
  agentId: string;
  snapshot: NormalizedAgentSnapshot;
  goal: string;
  allowPush: boolean;
  allowOpenPr: boolean;
}

const TERMINAL = new Set<MetaRunStatus>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'taken_over',
]);
export function snapshotDigest(json: string): string {
  return createHash('sha256').update(json).digest('hex');
}

function rowToSummary(row: AgentRunsTable): MetaRunSummary {
  const agentProtocol = storedProtocol(row.snapshot_json);
  return {
    id: row.id,
    projectId: row.project_id,
    sourceWorkspaceId: row.source_workspace_id,
    coordinatorWorkspaceId: row.coordinator_workspace_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    agentRevision: row.agent_revision,
    goal: row.goal,
    status: row.status,
    allowPush: row.allow_push === 1,
    allowOpenPr: row.allow_open_pr === 1,
    finalSummary: row.final_summary,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    ...(agentProtocol ? { agentProtocol } : {}),
    coordinatorSkillUsage: parseStoredSkillUsage(
      row.coordinator_skill_usage_json,
    ),
  };
}

function storedProtocol(json: string): 'debby' | undefined {
  try {
    const parsed = JSON.parse(json) as { protocol?: unknown; slug?: unknown };
    if (parsed.protocol === 'debby') return 'debby';
    // Compatibility for runs written before protocol identity became explicit.
    return parsed.protocol === undefined && parsed.slug === 'debby'
      ? 'debby'
      : undefined;
  } catch {
    return undefined;
  }
}

export class AgentRunsRepo {
  constructor(private readonly db: AppDatabase) {}
  async create(input: CreateAgentRunInput): Promise<MetaRunSummary> {
    const now = Date.now();
    const json = JSON.stringify(input.snapshot);
    const row: AgentRunsTable = {
      id: uuidv7(),
      project_id: input.projectId,
      source_workspace_id: input.sourceWorkspaceId,
      coordinator_workspace_id: null,
      agent_id: input.agentId,
      agent_name: input.snapshot.name,
      agent_revision: input.snapshot.revision,
      snapshot_json: json,
      snapshot_digest: snapshotDigest(json),
      goal: input.goal,
      allow_push: input.allowPush ? 1 : 0,
      allow_open_pr: input.allowOpenPr ? 1 : 0,
      status: 'starting',
      final_summary: null,
      error: null,
      created_at: now,
      started_at: null,
      ended_at: null,
      coordinator_skill_usage_json: serializeSkillUsage({
        reported: false,
        skills: [],
      }),
    };
    await this.db.insertInto('agent_runs').values(row).execute();
    return rowToSummary(row);
  }
  async get(id: string): Promise<MetaRunSummary> {
    return rowToSummary(await this.requireRow(id));
  }
  async list(projectId: string): Promise<MetaRunSummary[]> {
    return (
      await this.db
        .selectFrom('agent_runs')
        .selectAll()
        .where('project_id', '=', projectId)
        .orderBy('created_at', 'desc')
        .execute()
    ).map(rowToSummary);
  }
  async snapshot(id: string): Promise<NormalizedAgentSnapshot> {
    const row = await this.requireRow(id);
    if (snapshotDigest(row.snapshot_json) !== row.snapshot_digest)
      throw new AppError('internal', 'stored agent snapshot digest mismatch');
    return parseStoredAgentSnapshot(row.snapshot_json);
  }
  async setCoordinator(id: string, workspaceId: string): Promise<void> {
    const result = await this.db
      .updateTable('agent_runs')
      .set({
        coordinator_workspace_id: workspaceId,
        status: 'running',
        started_at: Date.now(),
      })
      .where('id', '=', id)
      .where('status', '=', 'starting')
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n)
      throw new AppError('conflict', 'meta run is no longer starting', { id });
  }
  async transition(
    id: string,
    status: MetaRunStatus,
    extra: {
      summary?: string;
      error?: string;
      skillUsage?: MetaSkillUsageReport;
    } = {},
  ): Promise<MetaRunSummary> {
    const set: Partial<AgentRunsTable> = {
      status,
      ...(extra.summary !== undefined ? { final_summary: extra.summary } : {}),
      ...(extra.error !== undefined ? { error: extra.error } : {}),
      ...(extra.skillUsage !== undefined
        ? {
            coordinator_skill_usage_json: serializeSkillUsage(extra.skillUsage),
          }
        : {}),
      ...(TERMINAL.has(status) ? { ended_at: Date.now() } : {}),
    };
    await this.db
      .updateTable('agent_runs')
      .set(set)
      .where('id', '=', id)
      .where('status', 'in', ['starting', 'running'])
      .executeTakeFirst();
    // The conditional update is the exactly-once arbiter. A racing terminal
    // transition returns the durable winner instead of fabricating local state.
    return this.get(id);
  }
  async interruptStale(): Promise<MetaRunSummary[]> {
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('agent_runs')
        .selectAll()
        .where('status', 'in', ['starting', 'running'])
        .execute();
      const now = Date.now();
      if (rows.length)
        await trx
          .updateTable('agent_runs')
          .set({
            status: 'interrupted',
            error: 'application exited while the run was active',
            ended_at: now,
          })
          .where(
            'id',
            'in',
            rows.map((row) => row.id),
          )
          .where('status', 'in', ['starting', 'running'])
          .execute();
      return rows.map((row) =>
        rowToSummary({
          ...row,
          status: 'interrupted',
          error: 'application exited while the run was active',
          ended_at: now,
        }),
      );
    });
  }
  private async requireRow(id: string): Promise<AgentRunsTable> {
    const row = await this.db
      .selectFrom('agent_runs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new AppError('not_found', 'meta run not found', { id });
    return row;
  }
}
