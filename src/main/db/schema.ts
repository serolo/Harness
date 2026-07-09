// Kysely table (row) types for the SQLite database.
//
// These describe the DB storage shape, which is deliberately NOT identical to the
// DTOs in `src/shared/models.ts`:
//   - SQLite has no boolean type — booleans are stored as INTEGER 0/1 (none in the
//     Phase 0 core tables, but the convention is documented here for later tables).
//   - Enum-ish columns are stored as TEXT; we widen them to the shared string-literal
//     unions so a read is typed, while a write is still validated by the repo layer.
//   - Nullable DDL columns (spec §3) map to `x | null`.
// The row↔DTO mapping is kept EXPLICIT in the repos (repos/projects.ts,
// repos/workspaces.ts) — never implicit — so a schema drift surfaces at the mapping.

import type {
  TurnStatus,
  WorkspaceSourceKind,
  WorkspaceStatus,
} from '@shared/models';
import type { AgentMode, HarnessId } from '@shared/harness';

/**
 * `projects` table (spec §3 DDL). Column set is authoritative:
 * id, name, origin_url, default_branch, repo_path, created_at.
 */
export interface ProjectsTable {
  id: string; // TEXT PRIMARY KEY — UUIDv7
  name: string; // TEXT NOT NULL
  origin_url: string; // TEXT NOT NULL
  default_branch: string; // TEXT NOT NULL
  repo_path: string; // TEXT NOT NULL
  created_at: number; // INTEGER NOT NULL — epoch millis
}

/**
 * `workspaces` table (spec §3 DDL). Nullable columns per the DDL:
 * worktree_path, source_kind, source_ref, port, archived_at.
 * `status`, `source_kind`, and `harness` are TEXT but typed as the frozen
 * string-literal unions from the shared contracts.
 */
export interface WorkspacesTable {
  id: string; // TEXT PRIMARY KEY — UUIDv7
  project_id: string; // TEXT NOT NULL REFERENCES projects(id)
  name: string; // TEXT NOT NULL — city name, unique per project
  branch: string; // TEXT NOT NULL
  base_branch: string; // TEXT NOT NULL
  worktree_path: string | null; // TEXT — NULL when archived
  status: WorkspaceStatus; // TEXT NOT NULL — idle|working|needs_attention|running|archived
  source_kind: WorkspaceSourceKind | null; // TEXT — none|branch|pr|github_issue|linear_issue
  source_ref: string | null; // TEXT — PR number / issue key / branch name
  harness: HarnessId; // TEXT NOT NULL — claude_code|codex|cursor
  port: number | null; // INTEGER — allocated dev-server port
  created_at: number; // INTEGER NOT NULL — epoch millis
  archived_at: number | null; // INTEGER — epoch millis, NULL until archived
  pr_number: number | null; // INTEGER — PR number, migration 0007, NULL until a PR is opened
}

/**
 * `turns` table (migration 0003 — Phase 2). One agent request/response cycle scoped
 * to a workspace. `status`/`mode` are TEXT widened to the frozen shared unions; the
 * write path (TurnsRepo) validates. Nullable per DDL: session_id, mode, ended_at,
 * input_tokens, output_tokens. `idx` is the 0-based ordinal, UNIQUE per workspace.
 */
export interface TurnsTable {
  id: string; // TEXT PRIMARY KEY — UUIDv7
  workspace_id: string; // TEXT NOT NULL REFERENCES workspaces(id)
  idx: number; // INTEGER NOT NULL — 0-based ordinal, UNIQUE per workspace
  status: TurnStatus; // TEXT NOT NULL — streaming|completed|interrupted|error
  session_id: string | null; // TEXT — harness resume handle
  mode: AgentMode | null; // TEXT — plan|default|auto_accept
  started_at: number; // INTEGER NOT NULL — epoch millis
  ended_at: number | null; // INTEGER — epoch millis, NULL while streaming
  input_tokens: number | null; // INTEGER — usage at turn end
  output_tokens: number | null; // INTEGER
  reverted_at: number | null; // INTEGER — epoch millis (migration 0005), NULL unless reverted
}

/**
 * `events` table (migration 0003 — Phase 2). The frozen `AgentEvent`s emitted during
 * a turn, stored as opaque JSON. `kind` is deliberately NOT narrowed to a union —
 * unknown future event kinds must round-trip (forward-compat, see the migration note);
 * `payload_json` is the full `JSON.stringify(AgentEvent)`.
 */
export interface EventsTable {
  id: string; // TEXT PRIMARY KEY — UUIDv7
  turn_id: string; // TEXT NOT NULL REFERENCES turns(id)
  kind: string; // TEXT NOT NULL — AgentEvent.kind, not narrowed (forward-compat)
  payload_json: string; // TEXT NOT NULL — JSON.stringify(AgentEvent)
  ts: number; // INTEGER NOT NULL — epoch millis
}

/**
 * `checkpoints` table (migration 0005 — Phase 4). One row per per-turn
 * `git commit-tree` snapshot (spec §9), used to power revert. `ref_name` is the
 * `refs/checkpoints/<workspace>/<idx>` ref the commit is anchored under; `sha` is
 * the commit-tree SHA itself.
 */
export interface CheckpointsTable {
  id: string; // TEXT PRIMARY KEY — UUIDv7
  workspace_id: string; // TEXT NOT NULL REFERENCES workspaces(id)
  turn_id: string; // TEXT NOT NULL REFERENCES turns(id)
  ref_name: string; // TEXT NOT NULL — refs/checkpoints/<ws>/<idx>
  sha: string; // TEXT NOT NULL — commit-tree SHA
  created_at: number; // INTEGER NOT NULL — epoch millis
}

/**
 * `diff_comments` table (migration 0005 — Phase 4). Inline review comments that
 * become `diff_comment` agent attachments. `line_start`/`line_end`/`side` are
 * NULL for a file-level (not line-anchored) comment. `state` tracks the comment's
 * lifecycle: open|sent|resolved.
 */
export interface DiffCommentsTable {
  id: string; // TEXT PRIMARY KEY — UUIDv7
  workspace_id: string; // TEXT NOT NULL REFERENCES workspaces(id)
  file_path: string; // TEXT NOT NULL
  line_start: number | null; // INTEGER — NULL for a file-level comment
  line_end: number | null; // INTEGER — NULL for a file-level comment
  side: 'old' | 'new' | null; // TEXT — NULL for a file-level comment
  body: string; // TEXT NOT NULL
  state: 'open' | 'sent' | 'resolved'; // TEXT NOT NULL
  created_at: number; // INTEGER NOT NULL — epoch millis
}

/**
 * `todos` table (migration 0005 — Phase 4). Fed by agent `todo_update` events and
 * user-authored entries alike (`source`). `done` is INTEGER 0/1 — SQLite has no
 * boolean type (see file header convention).
 */
export interface TodosTable {
  id: string; // TEXT PRIMARY KEY — UUIDv7
  workspace_id: string; // TEXT NOT NULL REFERENCES workspaces(id)
  body: string; // TEXT NOT NULL
  done: number; // INTEGER NOT NULL — 0/1
  source: 'user' | 'agent'; // TEXT NOT NULL
  created_at: number; // INTEGER NOT NULL — epoch millis
  updated_at: number; // INTEGER NOT NULL — epoch millis
}

/**
 * `integrations` table (migration 0006 — Phase 5). One connected external account
 * (GitHub/Linear, spec §3). `account_label` is the human login label (nullable for a
 * connection that carries none). `token_ref` is the safeStorage ciphertext file id —
 * NEVER the raw token, which is encrypted at rest outside SQLite (spec §7).
 */
export interface IntegrationsTable {
  id: string; // TEXT PRIMARY KEY — UUIDv7
  kind: 'github' | 'linear'; // TEXT NOT NULL — provider
  account_label: string | null; // TEXT — human login label, NULL if none
  token_ref: string; // TEXT NOT NULL — safeStorage ciphertext id, NEVER the raw token
  created_at: number; // INTEGER NOT NULL — epoch millis
}

/**
 * The Kysely database interface. One key per table. Later phases APPEND their
 * tables here (turns, events, checkpoints, …) alongside their new migration —
 * never edit an existing table type in a way that diverges from a shipped
 * migration (README §5.3, additive schema).
 */
export interface Database {
  projects: ProjectsTable;
  workspaces: WorkspacesTable;
  turns: TurnsTable;
  events: EventsTable;
  checkpoints: CheckpointsTable;
  diff_comments: DiffCommentsTable;
  todos: TodosTable;
  integrations: IntegrationsTable;
}
