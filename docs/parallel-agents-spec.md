# Parallel Coding Agents — Technical Specification

**Version:** 0.1 (Draft)
**Author:** Sebastian
**Date:** July 2026
**Status:** For review

---

## 1. Overview

### 1.1 Product summary

A macOS desktop application for running multiple coding agents (Claude Code, Codex, Cursor) in parallel against a single repository. Each task runs in an isolated **workspace** backed by a git worktree, with its own branch, terminal, running app process, and chat session. The user monitors all agents from a sidebar dashboard, reviews changes in a built-in diff viewer, sends review feedback back to the agent, and merges through an integrated PR workflow.

### 1.2 Goals

- Run N agents concurrently on one repo without file conflicts (worktree isolation).
- Wrap agent CLIs the user already has installed and authenticated — no separate billing or API management.
- Make the review loop first-class: diff → inline comments → agent addresses them → merge readiness.
- Local-first: all code, chat history, and state live on the user's machine.
- Harness-agnostic: one UI over multiple agent CLIs via an adapter interface.

### 1.3 Non-goals (v1)

- Cloud/remote agent execution.
- Enterprise managed deployment / org policy distribution.
- Windows/Linux support (macOS only for v1).
- Multi-repo projects in a single workspace.
- Building our own agent — we orchestrate existing CLIs.

### 1.4 Definitions

| Term | Meaning |
|---|---|
| **Project** | A registered git repository managed by the app |
| **Workspace** | A git worktree + branch + agent session + terminal + metadata |
| **Harness** | An adapter that drives a specific agent CLI (Claude Code, Codex, Cursor) |
| **Turn** | One user-prompt → agent-response cycle, the unit for checkpoints |
| **Checkpoint** | A snapshot of the worktree taken at a turn boundary, revertible |
| **Checks** | Aggregated merge-readiness state (git, CI, PR, comments, todos) |

---

## 2. Architecture

### 2.1 High-level diagram

```
┌────────────────────────────────────────────────────────────┐
│                     Desktop Shell (Electron)                │
│                                                             │
│  ┌──────────────────────┐      ┌─────────────────────────┐  │
│  │  Renderer (React)    │ IPC  │  Main Process (Node/TS) │  │
│  │                      │◄────►│                         │  │
│  │  Sidebar / Dashboard │      │  WorkspaceManager       │  │
│  │  Chat UI             │      │  GitService (git CLI)   │  │
│  │  Diff Viewer         │      │  HarnessSupervisor      │  │
│  │  Terminal (xterm.js) │      │  PtyService             │  │
│  │  Checks Panel        │      │  ProcessRunner (ports)  │  │
│  │  Settings UI         │      │  CheckpointService      │  │
│  └──────────────────────┘      │  SettingsService (TOML) │  │
│                                │  IntegrationService     │  │
│                                │   ├─ GitHub (REST/GQL)  │  │
│                                │   └─ Linear (GraphQL)   │  │
│                                │  Store (SQLite)         │  │
│                                └───────────┬─────────────┘  │
└────────────────────────────────────────────┼────────────────┘
                                             │ spawns (PTY / headless)
                              ┌──────────────┼──────────────┐
                              │              │              │
                        claude (CLI)    codex (CLI)   cursor (CLI)
                              │              │              │
                        ~/.app/worktrees/<project>/<workspace>/
```

**Stack decision:** Electron (system Chromium + a Node.js/TypeScript **main process**; React + TypeScript **renderer**). The "core" is a TypeScript main process, not a native binary. Rationale: a single-language codebase where main and renderer share types over a typed IPC bridge with **no cross-language codegen**; the richest ecosystem for the CLIs/PTYs/git tooling we wrap (`node-pty`, Octokit, `better-sqlite3`); and mature packaging + auto-update (`electron-builder` / `electron-updater`). Trade-off vs a Rust/Tauri shell: larger binary and higher baseline memory — mitigated by lazy-loading views, bounding per-workspace child processes, and (if DB work ever blocks the event loop) moving SQLite to a `utilityProcess`.

### 2.2 Process model

- **One main process** (Node.js/TypeScript) owns all state, git operations, PTYs, and child agent processes.
- **One renderer** (Chromium) renders the UI; communicates via a typed IPC bridge (`contextBridge` preload) — request/response channels plus event/stream channels. `contextIsolation` on, `nodeIntegration` off.
- **Per workspace:** 0–1 agent process (headless CLI), 0–N terminal PTYs, 0–N run-script processes.
- Agent processes survive UI navigation (switching workspaces does not kill agents). App quit gracefully interrupts agents and stops run processes.

### 2.3 Filesystem layout

```
~/Library/Application Support/<app>/
├── app.db                      # SQLite
├── settings.toml               # user-level settings
├── logs/
├── secrets/                    # safeStorage ciphertext (token blobs), never plaintext
└── projects/
    └── <project-id>/
        ├── repo/               # base clone (default branch checkout)
        └── worktrees/
            ├── lisbon/         # workspace worktree
            ├── osaka/
            └── ...
```

Repo-level settings live in the repo itself: `.harness/settings.toml` (shared, committed) and `.harness/settings.local.toml` (gitignored overrides).

---

## 3. Data model (SQLite)

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,             -- uuid
  name TEXT NOT NULL,
  origin_url TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,              -- city name, unique per project
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  worktree_path TEXT,              -- NULL when archived
  status TEXT NOT NULL,            -- idle|working|needs_attention|running|archived
  source_kind TEXT,                -- none|branch|pr|github_issue|linear_issue
  source_ref TEXT,                 -- PR number / issue key / branch name
  harness TEXT NOT NULL,           -- claude_code|codex|cursor
  port INTEGER,                    -- allocated dev-server port
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  idx INTEGER NOT NULL,            -- 0..n within workspace
  user_prompt TEXT NOT NULL,
  attachments_json TEXT,           -- file refs, inline diff comments
  status TEXT NOT NULL,            -- streaming|complete|interrupted|error
  started_at INTEGER, ended_at INTEGER
);

CREATE TABLE events (                -- streamed agent events, replayable chat
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  kind TEXT NOT NULL,              -- text|tool_use|tool_result|file_edit|todo_update|error
  payload_json TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  ref_name TEXT NOT NULL,          -- refs/checkpoints/<ws>/<idx>
  created_at INTEGER NOT NULL
);

CREATE TABLE diff_comments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line_start INTEGER, line_end INTEGER,
  side TEXT,                       -- old|new
  body TEXT NOT NULL,
  state TEXT NOT NULL,             -- open|sent|resolved
  created_at INTEGER NOT NULL
);

CREATE TABLE todos (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  body TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,            -- user|agent
  created_at INTEGER NOT NULL
);

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- github|linear
  account_label TEXT,
  token_ref TEXT NOT NULL          -- safeStorage ciphertext reference, never the token
);
```

Chat history is reconstructed from `turns` + `events`, which is what makes archive/restore of full conversations possible.

---

## 4. Harness abstraction

### 4.1 Interface

```ts
interface Harness {
  id: "claude_code" | "codex" | "cursor";
  detect(): Promise<{ installed: boolean; version?: string; authenticated: boolean }>;

  startTurn(opts: {
    workspaceDir: string;
    prompt: string;
    attachments: Attachment[];       // files, images, diff comments
    sessionId?: string;              // resume previous session
    mode?: AgentMode;                // e.g. plan / default / auto-accept
    mcpConfig?: McpServerConfig[];
    permissionPolicy: PermissionPolicy;
  }): TurnHandle;
}

interface TurnHandle {
  events: AsyncIterable<AgentEvent>; // normalized stream
  interrupt(): Promise<void>;
  sessionId: string;                 // for resume
}

type AgentEvent =
  | { kind: "text"; delta: string }
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "tool_result"; output: unknown }
  | { kind: "file_edit"; path: string; op: "create" | "modify" | "delete" }
  | { kind: "todo_update"; todos: Todo[] }
  | { kind: "turn_end"; usage?: Usage }
  | { kind: "error"; message: string };
```

### 4.2 Claude Code adapter (v1 primary)

- Spawn `claude -p "<prompt>" --output-format stream-json --verbose` with `cwd` = worktree.
- Resume with `--resume <session-id>` to maintain conversation across turns.
- Parse the stream-JSON events and normalize into `AgentEvent`.
- Auth is inherited from the user's existing `claude` login (subscription or API key); the app never handles model credentials.
- Permission policy maps to Claude Code's permission flags/settings; MCP config is passed through via a generated `.mcp.json` or CLI flags.
- File edits are detected from tool events and also verified via `git status` polling to drive the diff badge.

### 4.3 Codex / Cursor adapters (v1.1)

Same interface; each maps to its CLI's headless/JSON mode. Capability flags (`supportsResume`, `supportsMcp`, `supportsPlanMode`) let the UI degrade gracefully per harness.

---

## 5. Core subsystems

### 5.1 Workspace engine

**Create workspace:**
1. Allocate name (city list, unique per project) and branch (`<prefix>/<name>` or user-specified).
2. `git -C repo fetch origin` → `git worktree add worktrees/<name> -b <branch> origin/<base>`.
3. Run `setup` script from settings (streamed to a setup log panel).
4. Allocate a free TCP port; record on the workspace.
5. If created from a PR / GitHub issue / Linear issue: fetch title + body, prefill the composer as the first prompt; for PRs, check out the PR head branch instead of creating a new one.

**Archive:** run optional `archive` script → stop processes → `git worktree remove` → keep DB rows (turns, events, comments, todos) → status = archived. **Restore:** re-add worktree from the branch (or recreate branch from last checkpoint ref if deleted) and reattach chat history.

**Status machine:** `idle → working` (turn streaming) `→ needs_attention` (turn ended, error, or permission request) `→ idle`; `running` overlays when a run script is active. Sidebar and macOS notifications key off `needs_attention`.

### 5.2 Terminal & run scripts

- PTY per terminal tab (node-pty), rendered with xterm.js; environment includes `PORT`/`APP_PORT` = allocated port, workspace path vars.
- Named run scripts from settings render as buttons (icon + label). One-click start/stop; stdout/stderr tail into a Run panel. `run_mode = "concurrent"` allows multiple named scripts simultaneously.
- Big Terminal Mode: maximize terminal to full window (toggle shortcut).
- Open-in-IDE: `cursor <path>` / `code <path>` launchers.

### 5.3 Diff viewer

- Diff = worktree vs `merge-base(HEAD, origin/<base>)`; recomputed on FS events (debounced watcher) and after each turn.
- File tree with add/modify/delete badges and per-file stats; unified and side-by-side modes; syntax highlighting (Shiki/Monaco); per-commit filtering via `git log <base>..HEAD` selector.
- **Inline comments:** select line range → comment → stored as `diff_comments(open)`. "Send to agent" serializes open comments (file, range, code excerpt, comment body) as a structured attachment on the next turn, then marks them `sent`. Agent resolution flips them `resolved` when the lines change.
- **Agent review action:** one click runs a turn with a canned review prompt over the current diff; output renders as review annotations.

### 5.4 Checkpoints

- On each `turn_end`, snapshot: `git add -A` in a temp index → `git commit-tree` → store as `refs/checkpoints/<workspace>/<turn-idx>` (never touches the user's branch history).
- Revert to turn N: hard-reset worktree files to that ref (with confirm + auto-backup checkpoint of the current state), truncate visible chat after turn N, and start a fresh agent session seeded with a summary of retained turns (since CLI sessions can't be truncated mid-stream).

### 5.5 Checks panel (merge readiness)

Aggregates, per workspace:

| Source | Signal |
|---|---|
| Git | uncommitted changes, unpushed commits, behind base |
| PR | exists / draft / mergeable state |
| CI | GitHub check runs + commit statuses (pass/fail/pending) |
| Deployments | GitHub deployment statuses |
| Review | unresolved PR review threads (in-app resolvable) |
| Todos | open todos (user- or agent-created) |

Blockers (red) gate the Merge button; the panel suggests the next action ("Commit & push", "Create PR", "Fix failing check" → each is a one-click agent prompt or git action).

### 5.6 PR workflow

- ⌘⇧P: commit (if needed), push branch, open PR with agent-drafted title/description (template from settings), draft toggle.
- Review comments ingested via GraphQL; "Fix review comments" sends unresolved threads to the agent as attachments.
- "Fix failing checks" fetches failing check-run logs (truncated) and prompts the agent.
- Merge (merge/squash/rebase per repo settings) enabled only when Checks is green; post-merge prompt to archive the workspace.

### 5.7 Settings system

TOML, layered; highest wins:

1. Managed (`/Library/Application Support/<app>/managed.toml`) — reserved, v2
2. Project local (`.harness/settings.local.toml`, gitignored)
3. Project shared (`.harness/settings.toml`, committed)
4. User (`~/.../settings.toml`)
5. Built-in defaults

Validated against a published JSON Schema; Settings UI writes to the correct layer and shows effective (merged) values with provenance. Hot-reload on file change. Key sections: `[scripts]` (setup/run/archive, `run_mode`), `[env]`, `[agent]` (default harness, mode, permission policy, prompts), `[git]` (branch prefix, merge strategy), `[mcp]`.

### 5.8 Shortcuts, deep links, notifications

- Shortcuts: ⌘⇧N new workspace, ⌘⇧D diff, ⌘⇧P PR, ⌘K command palette, ⌘1..9 workspace switch, ⌘T terminal, configurable map.
- Deep link scheme `harness://workspace/<id>` (+ `.../diff`, `.../pr`) for notification click-through and external tooling.
- Native notifications on `needs_attention`, turn completion (configurable), failing checks.

---

## 6. Integrations

**GitHub:** OAuth device flow (fallback: PAT). Token encrypted at rest with Electron `safeStorage` (Keychain-backed) — ciphertext on disk, never the raw token in the DB. Octokit REST for PRs/check-runs/statuses/deployments; GraphQL for review threads + resolution. Polling with ETags/conditional requests (webhooks are out of scope for a desktop app); refresh on window focus.

**Linear:** OAuth; GraphQL. Issue picker for workspace creation; write-back: link branch/PR to issue, optional status transition on PR open/merge.

---

## 7. Security & privacy

- All repo content and chat history local (SQLite + filesystem); no server component in v1.
- Tokens encrypted via Electron `safeStorage` (Keychain-backed); DB stores only a ciphertext reference, never the raw token.
- Agent permission policy per project: allowed tools, command allow/deny lists, confirm-before-run surfaces as `needs_attention`.
- Run scripts and agent commands execute with user privileges inside the worktree; no sandbox claim in v1 (document clearly).
- Crash/usage telemetry opt-in only.

---

## 8. Milestones

**M1 — Workspace engine (2 wk):** project add/clone, worktree create/archive/restore, city names, setup scripts, sidebar, SQLite store.
**M2 — Claude Code harness + chat (2 wk):** stream-JSON adapter, resume, chat UI with attachments, turn persistence, status machine, notifications.
**M3 — Terminal + run (1 wk):** PTYs, run buttons, port allocation, big terminal, open-in-IDE.
**M4 — Diff + review loop (2 wk):** diff engine, viewer, inline comments → agent attachments, agent review action, checkpoints.
**M5 — GitHub + Checks + PR flow (2 wk):** OAuth, PR create/merge, check runs, review threads, Checks panel with blockers, todos.
**M6 — Config & polish (1–2 wk):** TOML layering + schema, MCP passthrough, slash commands, shortcuts, deep links, auto-update (electron-updater), onboarding.
**v1.1:** Codex + Cursor harnesses, Linear, per-commit diff filtering extras, command palette depth.

MVP = M1–M4 (core value: parallel agents + review loop). Complete-feeling product = through M5.

---

## 9. Risks & open questions

| Risk | Mitigation |
|---|---|
| Agent CLI output formats change between versions | Version-detect in `detect()`; pin minimum versions; adapter contract tests against recorded fixtures |
| Checkpoint revert vs CLI session state mismatch | Fresh session + summary seeding on revert (5.4); document behavior |
| Port conflicts with user's own processes | Probe-and-retry allocation; overridable per workspace |
| Worktree + long-running dev servers on archive | Hard-stop process tree (SIGTERM→SIGKILL) before `worktree remove` |
| GitHub rate limits with many workspaces | ETag caching, focus-based refresh, per-project batching via GraphQL |
| Monorepo scale (huge diffs, slow status) | Sparse checkout support (v1.1); diff pagination; cached `git status`/diff via the git CLI |

**Open:** name/branding; whether chat renders raw terminal output as fallback for harnesses without JSON streams; multi-account GitHub; team-shared settings distribution before enterprise tier.

---

## 10. Cross-workspace dispatch (Phase 11)

One orchestrator workspace can suggest handing a sub-task (`implement` / `review` / `explore` /
`search`) to another workspace. A **human click** creates the dispatch; a **second human click**
starts it. This section is the framing note the Phase-11 plan requires — it states why the feature
stays inside the §1.3 non-goal, not just how it is built.

### 10.1 It is glue, not a new agent

Every dispatched turn is an ordinary `HarnessSupervisor.startTurn` in an ordinary worktree. Dispatch
adds **no** new execution surface: it composes the existing `WorkspaceManager.create`/`get` (the only
worktree-creation path) and the existing `turn:start` producer. It is structurally identical to the
existing `pr:fixReviews` / `pr:fixChecks` flows — glue that assembles a prompt and routes it into a
turn — differing only in that the turn runs in a *different* workspace than the one that suggested it.
The single-turn invariant, checkpoints, the status machine, and worktree isolation (§2.2, §5.1, §5.4)
all apply unchanged; a dispatched turn is indistinguishable from a hand-typed one once it starts.

### 10.2 Why this does not violate the §1.3 non-goal

§1.3 lists as a non-goal: _"Building our own agent — we orchestrate existing CLIs."_ Dispatch
orchestrates existing CLIs and nothing else. There is **no** callback channel from a spawned process
back into the app, no in-turn "dispatch tool" the CLI can invoke, and no autonomous loop — the app
never decides on its own to spawn work. A CLI-spawned process cannot create or start a dispatch; only
a human clicking in the renderer can. Scope "4b" (an in-turn MCP dispatch tool) is explicitly **out**.

This is nonetheless a **reinterpretation** of the non-goal's spirit — "orchestrate existing CLIs" now
covers CLIs orchestrating *each other's workspaces* under human control. Per the Phase-11 plan's
process tasks, this reinterpretation **requires written sign-off from the spec owner (Sebastian)
before merge to main**. That sign-off is a human task; it is surfaced as an explicit unchecked item in
the PR description and is not something the implementation tooling can satisfy on its own.

### 10.3 Human-click-only, and a human always merges

Two invariants keep the human in the loop at both ends:

- **Human-click-only.** Creating a dispatch is one explicit click; starting it is a second explicit
  click. Nothing auto-starts after creation, and nothing creates a dispatch without a click.
- **A human always merges.** `pr:merge` (§5.6) stays reachable only from the renderer Merge button →
  the `pr:merge` handler. It is **provably unreachable** from dispatch code: no module under
  `src/main/dispatch/**` may reference `pr:merge` or import the PrWorkflow implementation
  (`integrations/github/pr`). This is enforced mechanically by the `dispatch_isolation` BLOCKING CI
  gate in `ci/harness-gates.sh`, not by review alone.

Subsystem-level invariants (policy-gate-first ordering, review isolation, the guarded status machine)
are documented in `src/main/dispatch/CLAUDE.md`.
