# Meta Harness and File-Configured Agents — Implementation Plan

## Ticket

Replicate the useful behavior of Omnigent's built-in agents and custom-agent bundles inside Harness:

- Ship Polly, Debby, and a Harness-native PIV workflow as built-in examples.
- Load project-scoped custom agents from file-backed configuration.
- Add a bounded meta-harness loop that can delegate work to isolated Harness workspaces and provider CLIs.
- Add an Agents UI as a peer of Tasks and Knowledge, and allow scheduled tasks to run an agent.

References:

- [Omnigent built-in agents](https://omnigent.ai/docs/use/builtin-agents)
- [Polly](https://omnigent.ai/docs/use/builtin-agents/polly)
- [Debby](https://omnigent.ai/docs/use/builtin-agents/debby)
- [Custom agents](https://omnigent.ai/docs/use/custom-agents)
- [Polly source](https://github.com/omnigent-ai/omnigent/tree/main/examples/polly)
- [Debby source](https://github.com/omnigent-ai/omnigent/tree/main/examples/debby)

The Omnigent examples are Apache-2.0. Preserve attribution for adapted behavior and configuration, but do not copy their unsandboxed execution settings into Harness.

## Product and Architecture Decisions

These decisions close ambiguities in the raw request and define the first releasable version.

1. **Agent definitions are project-scoped and app-managed.** Custom bundles live below `<userData>/projects/<projectId>/agents/<slug>/`. Import copies a bundle into that directory; Harness does not continuously execute or edit arbitrary external paths.
2. **Built-ins are immutable templates.** Polly, Debby, and Harness ship as versioned resources. Users duplicate a built-in into a custom project agent before editing it.
3. **Compatibility is intentionally a safe subset of Omnigent YAML.** Support root and child configs, `prompt`, relative `instructions`, executor/provider selection, `tools.agents`, bundled `skills/*/SKILL.md`, and bounded run limits. Normalize both documented executor shapes (`executor.harness` and `executor.config.harness`). Reject unsupported executable capabilities—arbitrary MCP servers, Python callables, shell/terminal tools, environment injection, and broad policy overrides—with actionable validation diagnostics.
4. **Configuration and execution state stay separate.** YAML and instruction files are the source of agent definitions. SQLite stores immutable run snapshots, dispatch state, task snapshots, and recovery metadata.
5. **The coordinator is an ordinary supervised turn.** A meta run creates a visible coordinator workspace and starts its brain through `HarnessSupervisor`. The coordinator receives only a capability-scoped MCP control server; child work also runs through `HarnessSupervisor` in ordinary isolated worktrees.
6. **Claude Code is the initial coordinator adapter.** It supports both MCP and plan/read-only execution in the existing adapter. Codex and Cursor remain eligible workers where installed; Cursor cannot be the coordinator until its adapter supports MCP. Make this a capability check, not a string special case, so another adapter can qualify later.
7. **Delegation is bounded.** V1 permits one child-dispatch level, a configured provider/role roster, strict fan-out and parallelism limits, deadlines, request/result size limits, and cycle detection. The MCP server exposes delegation-specific tools only; it never exposes generic IPC, filesystem, database, or merge access.
8. **Humans retain merge authority.** Polly can create PR-ready branches. Pushing or opening a PR requires explicit consent at run start and uses existing reviewed git/PR paths; the coordinator can never merge a PR.
9. **Scheduled runs are reproducible.** A scheduled task stores the selected agent's validated config snapshot and digest. Later edits affect new manual runs, not existing scheduled tasks. Re-selecting an agent refreshes a task snapshot.
10. **No silent recovery.** A crash marks an active meta run interrupted and recoverable, keeps all worktrees, and revokes its capability token. The user can inspect/take over the work; automation never resumes without a new explicit action.
11. **Agents are not Knowledge.** The new UI is a third Tasks-panel tab. Knowledge remains untrusted reference content and is never interpreted as executable agent configuration.

### Explicitly Out of Scope for V1

- Full Omnigent schema, runtime, API, or plugin compatibility.
- Arbitrary user-defined MCP, Python, function, shell, or terminal tools.
- Recursive/nested meta-agent delegation beyond the coordinator and its direct children.
- Autonomous merging, unattended push/PR creation without consent, or direct writes to another child's worktree.
- Selecting a meta agent from the ordinary live-chat composer.
- Source-controlled/global agent registries, remote bundle registries, cloud execution, or multi-device synchronization.

## Expected Runtime Flow

1. The registry loads immutable packaged agents and validated project bundles, resolving relative instruction and skill files inside each bundle boundary.
2. Starting an agent records its exact normalized snapshot and creates a coordinator workspace derived from the selected source workspace.
3. The main process creates a short-lived, run-scoped control broker and launches a bundled stdio MCP proxy for the coordinator CLI.
4. The coordinator calls bounded tools such as `dispatch`, `continue_dispatch`, `await_dispatches`, and `cancel_dispatch`.
5. Each dispatch creates or resumes a claimed child workspace and starts an ordinary turn through `HarnessSupervisor`. Results return as bounded summaries and diff metadata, not unrestricted filesystem contents.
6. The coordinator synthesizes the result. Debby's run view additionally preserves and displays both partner branches and critiques side-by-side. Polly and Harness preserve each worker/reviewer/verifier branch for inspection and takeover.
7. Completion, cancellation, interruption, or takeover revokes the broker, releases claims, updates durable state, and leaves human-controlled workspaces intact.

## Affected Files

### Read Before Implementing

- `AGENTS.md`
- `.Codex/rules/security.md`
- `.Codex/rules/architecture.md`
- `.Codex/rules/conventions.md`
- `docs/ai_harness/DEVELOPER_WORKFLOW.md`
- `docs/implementation-plan/README.md:443`
- `docs/implementation-plan/phase-11-cross-workspace-dispatch.md:18`
- `docs/parallel-agents-spec.md:24`
- `src/shared/harness.ts:12`
- `src/shared/ipc.ts:147`
- `src/shared/tasks.ts:39`
- `src/main/harness/supervisor.ts:66`
- `src/main/harness/claude-code.ts:616`
- `src/main/harness/codex.ts:826`
- `src/main/harness/cursor.ts:76`
- `src/main/ipc/register.ts:939`
- `src/main/ipc/register.ts:2196`
- `src/main/index.ts:442`
- `src/main/context.ts:45`
- `src/main/scheduler/index.ts:167`
- `src/main/workspace/index.ts:144`
- `src/main/db/migrations/index.ts:13`
- `src/main/db/schema.ts:169`
- `src/main/db/repos/tasks.ts:39`
- `src/main/db/migrations/0014_task_effort.ts:3`
- `src/main/paths.ts:99`
- `src/main/settings/write.ts:66`
- `src/main/knowledge/AGENTS.md`
- `src/renderer/features/tasks/TasksPanel.tsx:113`
- `src/renderer/features/tasks/TaskForm.tsx:231`
- `src/renderer/features/tasks/useTasks.ts:61`
- `src/renderer/app/AppLayout.tsx:568`
- `src/preload/index.ts:74`
- `src/renderer/ipc/index.ts:45`
- `electron.vite.config.ts`
- `electron-builder.yml`
- `package.json`
- `scripts/migrate.ts`

### Modify

- `package.json` and `package-lock.json`
- `electron.vite.config.ts`
- `electron-builder.yml`
- `scripts/migrate.ts`
- `src/shared/ipc.ts` — append commands/events only
- `src/shared/tasks.ts` — append optional agent metadata without changing existing members
- `src/main/paths.ts`
- `src/main/context.ts`
- `src/main/index.ts`
- `src/main/ipc/register.ts`
- `src/main/scheduler/index.ts`
- `src/main/db/schema.ts`
- `src/main/db/migrations/index.ts`
- `src/main/db/repos/tasks.ts`
- `src/renderer/features/tasks/TasksPanel.tsx`
- `src/renderer/features/tasks/TaskForm.tsx`
- `src/renderer/features/tasks/TaskRow.tsx`
- `src/renderer/features/tasks/useTasks.ts`
- `src/renderer/app/AppLayout.tsx`
- `docs/implementation-plan/README.md`
- `docs/implementation-plan/phase-11-cross-workspace-dispatch.md`
- `docs/parallel-agents-spec.md`

Do not modify the generic preload/client bridge unless an implementation test proves a bridge change is required. The existing typed generic `invoke`/`on` machinery should acquire appended IPC entries automatically.

### Create

- `src/shared/agents.ts`
- `src/main/agents/AGENTS.md`
- `src/main/agents/config.ts`
- `src/main/agents/registry.ts`
- `src/main/agents/config.test.ts`
- `src/main/agents/registry.test.ts`
- `src/main/agents/builtins.test.ts`
- `src/main/meta-harness/AGENTS.md`
- `src/main/meta-harness/index.ts`
- `src/main/meta-harness/control-broker.ts`
- `src/main/meta-harness/mcp-stdio.ts`
- `src/main/meta-harness/control-broker.test.ts`
- `src/main/meta-harness/index.test.ts`
- `src/main/db/migrations/0015_meta_agents.ts`
- `src/main/db/migrations/0015_meta_agents.test.ts`
- `src/main/db/repos/agentRuns.ts`
- `src/main/db/repos/agentRuns.test.ts`
- `src/main/db/repos/agentDispatches.ts`
- `src/main/db/repos/agentDispatches.test.ts`
- `src/main/ipc/register.agents.test.ts`
- `src/renderer/features/agents/AgentsPanel.tsx`
- `src/renderer/features/agents/AgentEditor.tsx`
- `src/renderer/features/agents/AgentPicker.tsx`
- `src/renderer/features/agents/AgentRunView.tsx`
- `src/renderer/features/agents/useAgents.ts`
- `src/renderer/features/agents/AgentsPanel.test.tsx`
- `src/renderer/features/agents/AgentRunView.test.tsx`
- `resources/builtin-agents/NOTICE.md`
- `resources/builtin-agents/polly/config.yaml`
- `resources/builtin-agents/polly/agents/*/config.yaml`
- `resources/builtin-agents/polly/skills/*/SKILL.md`
- `resources/builtin-agents/debby/config.yaml`
- `resources/builtin-agents/debby/agents/*/config.yaml`
- `resources/builtin-agents/debby/skills/*/SKILL.md`
- `resources/builtin-agents/harness/config.yaml`
- `resources/builtin-agents/harness/agents/*/config.yaml`
- `resources/builtin-agents/harness/skills/*/SKILL.md`
- `docs/agent-config.md`
- `e2e/meta-harness.spec.ts`

Exact child-agent and skill filenames under each built-in should follow the roles established in Task 8; do not create placeholder roles that the runtime cannot enforce.

## Ordered Tasks

### Task 1 — Reconcile the Product Contract and Prior Roadmap

**What:**

- Update the post-v1 roadmap and Phase 11 document to state that this ticket authorizes the previously deferred autonomous orchestration layer, while retaining Phase 11's reviewed workspace isolation primitives.
- Update `docs/parallel-agents-spec.md` so “orchestrate existing CLIs” remains true but no longer contradicts the new bounded coordinator loop.
- Create `docs/agent-config.md` with the supported YAML grammar, normalization rules, validation errors, storage locations, execution/security model, bundle examples, versioning policy, and unsupported Omnigent fields.
- Record the attribution boundary and links to the upstream Polly and Debby sources.

**Pattern:** Follow the repository's spec-as-contract approach and use explicit “supported,” “rejected,” and “future” tables rather than implying full compatibility.

**Gotcha:** Do not weaken the existing Knowledge trust boundary or rewrite historical Phase 11 behavior as if autonomous dispatch was always included. This is a new, explicitly authorized layer.

**Validate:**

```bash
npx prettier --check docs/agent-config.md docs/implementation-plan/README.md docs/implementation-plan/phase-11-cross-workspace-dispatch.md docs/parallel-agents-spec.md
```

### Task 2 — Append the Shared Agent, Run, and IPC Contracts

**What:**

- Add `src/shared/agents.ts` with serializable, closed unions for agent origin, capabilities, validation diagnostics, normalized snapshots, run/dispatch status, dispatch purpose, summaries, and bounded run policy.
- Use stable IDs derived from origin/project/slug. Treat slugs as immutable in V1; rename is duplicate-then-delete.
- Append `metaAgent:*` commands for list/get/create/duplicate/import/read-file/validate-file/save-file/delete/start-run.
- Append `metaRun:*` commands for list/get/cancel/take-over, plus change and turn-started events. Keep these distinct from existing credential-oriented `agent:*` channels and scheduler-only `turn:event`.
- Append optional scheduled-task fields for `agentId`, display name/revision, and `metaRunId`; append `agentId` to create/update requests. Keep the actual raw snapshot main-only.
- Define a typed adapter capability used to select coordinators (`mcpControl` plus `readOnlyMode`) without extending or rewriting the frozen `HarnessId` union.

**Pattern:** Mirror nearby command/event definitions in `src/shared/ipc.ts`; append only. Keep all shared types free of Electron, Node, DOM, YAML, and native-module imports.

**Gotcha:** IPC input types must accept IDs, relative paths, bounded strings, and content only. Never allow renderer-supplied absolute paths, capability tokens, socket paths, raw database snapshots, or arbitrary executor command lines.

**Validate:**

```bash
npm run typecheck
node scripts/vitest-electron.mjs run src/preload/index.test.ts src/renderer/ipc/index.test.ts
```

### Task 3 — Package Dependencies, Built-in Resources, and the MCP Proxy Entry

**What:**

- Add direct runtime dependencies on `yaml` and `@modelcontextprotocol/sdk`; do not rely on transitive packages.
- Add a second electron-vite main input for the minimal stdio MCP proxy and ensure its output is packaged.
- Add `resources/builtin-agents/**` through `electron-builder.yml` `extraResources` with a deterministic production lookup path.
- Extend `src/main/paths.ts` for project agent roots, per-run private control directories, and packaged/development built-in roots.
- Create mode-0700 control directories and mode-0600 secret-bearing files. Centralize and test development-versus-packaged path resolution.

**Pattern:** Follow existing centralized path ownership in `src/main/paths.ts` and current multi-input electron-vite conventions. Launch the proxy with `process.execPath` and `ELECTRON_RUN_AS_NODE=1` so no second Node runtime is assumed.

**Gotcha:** Built-ins must work from the packaged app, not just the source checkout. Never place a capability token in argv, logs, renderer state, a worktree, or an agent bundle.

**Validate:**

```bash
npm install
npm run typecheck
npm run build
node scripts/vitest-electron.mjs run src/main/agents/builtins.test.ts
```

### Task 4 — Implement Strict Bundle Parsing and the Project Agent Registry

**What:**

- Implement strict YAML parsing with duplicate-key rejection, document/alias/depth/count/byte limits, known-key validation, closed executor/tool schemas, and normalized defaults.
- Resolve `instructions` and skill files only within the bundle using real-path containment checks. Reject symlinks, traversal, special files, nested surprises, and oversized imports.
- Support only `config.yaml`, `agents/<slug>/config.yaml`, and `skills/<slug>/SKILL.md` as editable bundle files.
- Implement atomic writes using temp-file-plus-rename and the safe-path patterns in settings writing.
- Implement import-by-copy into a freshly allocated app-managed slug. Validate the complete staging copy before atomically making it visible.
- Load immutable built-ins plus project agents, watch the managed directory with `chokidar`, debounce reloads, retain the last valid registry entry when an in-progress edit is temporarily invalid, and emit validation/change events.
- Delete custom agents only, using Electron's recoverable trash facility. Reject delete when a scheduled task references the agent until the user updates those tasks.

**Pattern:** Reuse the path containment, strict read, and atomic write approach from `src/main/settings/write.ts`; keep all filesystem access in main.

**Gotcha:** YAML is data, but several Omnigent fields grant code-execution authority. Reject unsupported executable fields rather than silently dropping them. Do not execute or import content from Knowledge.

**Validate:**

```bash
node scripts/vitest-electron.mjs run src/main/agents/config.test.ts src/main/agents/registry.test.ts src/main/agents/builtins.test.ts
```

Cover malformed YAML, duplicate keys, aliases/bombs, unknown keys, both executor shapes, traversal, symlinks, oversized files, invalid child references, atomic-write recovery, watcher reloads, immutable built-ins, and import/delete behavior.

### Task 5 — Add Durable Meta-Run, Dispatch, and Scheduled Snapshot Storage

**What:**

- Add migration `0015_meta_agents` with `agent_runs` and `agent_dispatches` tables and indexes.
- Store on each run: project/source/coordinator workspace IDs, agent ID/name/revision, normalized snapshot JSON and digest, goal, approval flags, status, final summary/error, and timestamps.
- Store on each dispatch: run/parent IDs, role and purpose, child agent, workspace/turn/session IDs, selected harness/model, status, bounded result metadata, error, and timestamps.
- Add nullable scheduled-task columns for agent ID/name/revision, the main-only snapshot JSON/digest, and current meta-run ID.
- Implement repositories with explicit row mappers and transactional status transitions. Do not deserialize snapshots without re-validating their stored schema version and digest.
- Replace the stub `scripts/migrate.ts` with a scratch/user-selected database migration runner consistent with the root migration requirement; it must never silently target the live app database.
- Document rollback/back-compat: older binaries ignore the new tables/columns; manual rollback rebuilds `scheduled_tasks` without the new nullable columns and drops the two new tables, losing only meta-run history and agent scheduling metadata.

**Pattern:** Follow migration 0014's additive migration and rollback-note style, current Kysely schema typing, and existing task repository tests with a real temporary SQLite database.

**Gotcha:** Existing scheduled tasks must remain behaviorally identical with all new columns NULL. Keep raw snapshots and control secrets out of renderer DTOs and logs.

**Validate:**

```bash
node scripts/vitest-electron.mjs run src/main/db/migrations/0015_meta_agents.test.ts src/main/db/repos/agentRuns.test.ts src/main/db/repos/agentDispatches.test.ts src/main/db/repos/tasks.test.ts
npm run migrate -- --help
```

Migration tests must cover a pre-0015 fixture, existing task preservation, indexes/constraints, idempotent startup application, and the documented rollback procedure on a copied database.

### Task 6 — Build the Capability-Scoped Control Broker and MCP Proxy

**What:**

- Implement a main-owned broker on a Unix domain socket inside the private run directory. Bind each connection to a cryptographically random, short-lived token and the exact run, project, allowed role/provider roster, claimed workspaces, approval flags, and limits.
- Implement a minimal stdio MCP proxy using the official SDK. It should translate only the approved tools to framed broker requests and contain no database, Electron IPC, git, filesystem, or process-execution API.
- Expose typed tools equivalent to:
  - `dispatch`: create an isolated child workspace and start a supervised turn.
  - `continue_dispatch`: start a follow-up turn in the same owned child workspace/session.
  - `await_dispatches`: wait for named dispatches to become terminal and return bounded/sanitized summaries.
  - `cancel_dispatch`: interrupt an owned active child.
- Enforce schema and byte limits before allocation, total dispatch/fan-out/parallel/depth budgets, per-turn deadlines, closed dispatch-purpose values, cycle prevention, ownership checks, and independent-provider rules for review roles.
- Redact tokens and sensitive paths from all errors. Revoke tokens and close sockets on completion, cancel, takeover, crash recovery, and application shutdown.

**Pattern:** Keep Electron main as the single authority. The proxy is a narrow transport adapter; the broker calls domain services, which call `WorkspaceManager` and `HarnessSupervisor`.

**Gotcha:** Never pass generic method names or an IPC-channel name over the broker. Never accept a workspace ID solely because the coordinator supplied it. The broker resolves and verifies every owned entity from durable run state.

**Validate:**

```bash
node scripts/vitest-electron.mjs run src/main/meta-harness/control-broker.test.ts
```

Include adversarial tests for wrong/expired tokens, cross-project and cross-run IDs, replay, excessive payloads, too many messages, timeout, cycle/depth violations, unauthorized provider/role, result truncation, cancellation races, shutdown cleanup, and error redaction.

### Task 7 — Implement MetaHarnessService and Workspace Claims

**What:**

- Implement `MetaHarnessService` as the sole lifecycle owner for starting, dispatching, waiting, completing, canceling, taking over, and recovering meta runs.
- On start, revalidate the chosen snapshot/capabilities, create a coordinator workspace through `WorkspaceManager`, create durable run state, start the broker, append its MCP server to coordinator settings, and start the coordinator through `HarnessSupervisor`.
- Keep the coordinator's turn active while MCP calls wait for children. Child turns use the same ordinary supervisor lifecycle and event persistence as human turns.
- Maintain explicit claims for coordinator and child workspaces. Add a main-owned `assertWorkspaceAvailable` check to ordinary `turn:start` and scheduler dispatch. Scheduler work targeting a claimed workspace queues; human takeover first cancels automation and revokes control, then releases the claim.
- Return bounded child results with status, branch/workspace identity, summary, changed-file/diff-stat metadata, and session identity needed for continuation. Do not read or return arbitrary child files.
- Implement terminal-state aggregation and exactly-once cleanup. Cancellation interrupts coordinator and active children; it never deletes their worktrees.
- On application boot, mark stale `starting`/`running` meta runs interrupted, revoke/remove stale control artifacts, preserve workspaces, and emit recoverable state. Do not auto-resume.
- Register shutdown before generic harness teardown so the broker is revoked before processes exit.

**Pattern:** Compose the existing `WorkspaceManager`, `HarnessSupervisor`, DB repositories, and lifecycle hooks in `src/main/index.ts`. Do not add a second provider process manager or write turns directly to SQLite.

**Gotcha:** Avoid the reservation race identified in the old Phase 11 design: claims must be established transactionally before a child is visible, and only the service's internal capability may start turns in claimed workspaces.

**Validate:**

```bash
node scripts/vitest-electron.mjs run src/main/meta-harness/index.test.ts src/main/harness/supervisor.test.ts src/main/scheduler/scheduler.test.ts
```

Exercise start, parallel dispatch, continuation, independent review enforcement, child failure, coordinator failure, cancellation, takeover, claim conflicts, queued scheduler behavior, boot interruption, shutdown, and exactly-once terminal updates.

### Task 8 — Define and Verify the Three Built-in Agents

**What:**

- Build **Polly** as a non-coding coordinator that decomposes work, delegates implementation into separate workspaces, assigns independent-provider reviews, requests follow-ups, and reports PR-ready branches for human merge. Include `/fanout`, `/cross-review`, and `/investigate` behavior as bounded bundled skills.
- Build **Debby** with two explicit partner roles—Claude and Codex—both answering independently, followed by configurable bounded critique rounds (default one) and coordinator synthesis. Preserve all partner answers and critiques as first-class run output for side-by-side display.
- Build **Harness** around this repository's PIV workflow: specification/deep analysis, implementation planning, coding, independently authored tests, adversarial verification, and code review. Map roles to the repository's existing harness workflow and rules, while packaging a versioned snapshot so behavior is deterministic outside this source checkout.
- Give each built-in a declared minimum adapter roster and capability diagnostics. Polly requires at least two installed worker providers for cross-vendor review; Debby requires Claude Code and Codex; Harness reports which optional independent stages are unavailable rather than substituting silently.
- Add upstream attribution and identify behavior adapted versus newly authored.

**Pattern:** Built-ins use exactly the same validated config and runtime path as custom agents. Tests should load packaged YAML, not recreate it as TypeScript fixtures.

**Gotcha:** Do not encode unsandboxed Omnigent policies, arbitrary imports, auto-merge, or unsupported provider IDs. Prompts must not claim authority the broker will reject.

**Validate:**

```bash
node scripts/vitest-electron.mjs run src/main/agents/builtins.test.ts src/main/meta-harness/index.test.ts
```

Tests must assert the exact role graphs, provider requirements, limits, default critique rounds, no merge capability, and successful validation under the same public schema used by imports.

### Task 9 — Wire Composition and Typed IPC End to End

**What:**

- Add registry, repositories, broker, and meta service to `AppContext`; construct them in dependency order in `src/main/index.ts`.
- Register all `metaAgent:*` and `metaRun:*` handlers through the existing normalized IPC error boundary.
- Validate every input with shared guards plus main-owned authorization/path checks. Resolve task snapshots, imports, duplicates, saves, deletes, starts, cancels, and takeovers in domain services rather than inside handler bodies.
- Broadcast registry/run changes and coordinator/child turn-start metadata through typed events. Do not reuse the scheduler-only `turn:event` producer path.
- Add subscription cleanup and application shutdown cleanup.

**Pattern:** Mirror the nearest existing handlers in `src/main/ipc/register.ts`; keep handlers narrow. Rely on the generic preload and renderer IPC layers after shared contract append.

**Gotcha:** This is a heightened-scrutiny IPC path. Do not expose filesystem paths, YAML parser objects, raw Error values, tokens, socket details, or unrestricted agent settings across the boundary.

**Validate:**

```bash
node scripts/vitest-electron.mjs run src/main/ipc/register.agents.test.ts src/preload/index.test.ts src/renderer/ipc/index.test.ts
```

Include malformed input, missing project, cross-project IDs, immutable built-in mutation, referenced-agent delete, missing adapter capability, and `AppError` encoding tests.

### Task 10 — Integrate Agents with Scheduled Tasks

**What:**

- Add a distinct Agent picker to `TaskForm`. “No agent” preserves the current provider/model/mode/effort workflow. Selecting an agent disables those controls and shows the agent-owned coordinator/provider requirements and revision.
- On task create/update, the main handler resolves the current validated agent and stores its immutable snapshot/digest transactionally. Never trust a renderer-supplied snapshot.
- At fire time, branch in the scheduler: ordinary tasks keep the current path; agent tasks call `MetaHarnessService` with the stored snapshot and attach the resulting meta-run ID.
- Derive task completion/failure/cancellation from the meta run and preserve existing queue, overlap, retry, and restart behavior. Reconcile stale task/meta-run combinations on boot without silently restarting them.
- Show a stale-revision badge if the registry now has a different digest, with an explicit “refresh task agent version” action.

**Pattern:** Extend existing task DTOs and repository transitions additively. Continue routing all provider processes through `HarnessSupervisor` via `MetaHarnessService`.

**Gotcha:** Do not merge model/provider overrides into the stored agent snapshot. Reject inconsistent input rather than silently choosing one. Existing task rows and schedules must remain unchanged when `agentId` is NULL.

**Validate:**

```bash
node scripts/vitest-electron.mjs run src/main/scheduler/scheduler.test.ts src/main/ipc/register.tasks.test.ts src/main/db/repos/tasks.test.ts src/renderer/features/tasks/TaskForm.test.tsx src/renderer/features/tasks/TasksPanel.test.tsx
```

### Task 11 — Add the Agents Tab, Editor, and Run Inspector

**What:**

- Add **Agents** beside **Tasks** and **Knowledge** in `TasksPanel`, retaining the pane's current accessible tab semantics, persistence, resizing, and narrow-width behavior.
- Show built-ins and custom agents with origin, description, revision, provider/capability availability, validation state, and actions to run, inspect, duplicate, import, edit, or delete as allowed.
- Implement a confined bundle editor that lists only allowed relative files, displays validation diagnostics with file/line context, validates before save, and makes atomic save explicit. Built-ins open read-only with a duplicate action.
- Add a start-run form for goal, source workspace, allowed run limits, and explicit push/PR consent. Do not expose merge consent because merging is unsupported.
- Add a run inspector showing coordinator state, branches/workspaces, child roles, provider/model, live status, summaries, failures, cancel/takeover/navigation actions, and retained work.
- Give Debby a dedicated comparison layout for both independent answers and each critique round, followed by synthesis. Do not collapse the partner output into the coordinator summary.
- Subscribe through `useAgents` to typed change events, refresh after reconnect, and clean up listeners on unmount.

**Pattern:** Follow `TasksPanel`, `useTasks`, existing dialogs/forms, design tokens, focus management, reduced-motion rules, and error/empty/loading patterns. Prefer a full-width modal/drawer for file editing rather than making the narrow side pane unusable.

**Gotcha:** Never render instruction/YAML content as HTML. Treat it as untrusted plain text. Keep tokens, managed absolute paths, raw snapshots, and internal MCP state out of renderer state.

**Validate:**

```bash
node scripts/vitest-electron.mjs run src/renderer/features/agents/AgentsPanel.test.tsx src/renderer/features/agents/AgentRunView.test.tsx src/renderer/features/tasks/TasksPanel.test.tsx
```

Test keyboard tab navigation, empty/loading/invalid states, built-in immutability, duplicate/import/edit flows, provider diagnostics, run/cancel/takeover, listener cleanup, Debby comparison rendering, and safe plain-text rendering.

### Task 12 — Demonstrate the Complete Behavior and Run Heightened-Scrutiny Review

**What:**

- Add a deterministic E2E seam using fake registered adapters/control responses; do not require installed vendor CLIs, credentials, network access, or real GitHub pushes.
- Cover: opening Agents, duplicating/editing a built-in, validation failure and recovery, starting a meta run, observing two isolated child workspaces, child continuation, completion, Debby comparison, cancellation/takeover, and scheduling an agent snapshot.
- Add lower-level integration evidence that real adapters receive a valid temporary MCP configuration without logging or persisting its token in a worktree.
- Run named reviews for IPC/preload hardening, process/MCP lifecycle, git/worktree isolation, database migration/recovery, filesystem bundle confinement, and secret/token handling.
- Update the nearest `AGENTS.md` files with non-obvious ownership and invariants discovered during implementation.

**Pattern:** Follow existing Electron Playwright fixtures and the repository's Definition of Done. Use deterministic fake adapters only at the provider boundary; keep registry, IPC, scheduler, DB, broker authorization, workspace creation, and UI real in the E2E path.

**Gotcha:** A happy-path mocked coordinator is insufficient. Completion evidence must include adversarial broker tests, migration tests, claim/race tests, and proof that cancellation/shutdown leaves no live token or socket.

**Validate:**

```bash
npx playwright test e2e/meta-harness.spec.ts
bash ci/harness-gates.sh
```

## Execution Strategy

Execute sequentially by dependency group:

1. Contract and shared types (Tasks 1–2).
2. Packaging, parsing, and persistence foundations (Tasks 3–5).
3. Security boundary and orchestration lifecycle (Tasks 6–7).
4. Built-ins and application integration (Tasks 8–10).
5. UI and end-to-end proof (Tasks 11–12).

Tasks within a group touch overlapping contracts and should not be implemented concurrently unless file ownership is explicitly split. Do not begin the UI against guessed IPC shapes, and do not write built-in prompts before the broker's enforceable capability vocabulary is stable.

After each task, run its narrow validation command and inspect `git diff --check`. Keep unrelated user changes intact. Before declaring completion, run the independent test-author, verifier, and code-review stages required by the repository workflow.

## Full Validation Gate

```bash
bash ci/harness-gates.sh
npx playwright test e2e/meta-harness.spec.ts
```

Additionally verify manually in a development build:

1. Built-ins appear without a source-tree dependency and cannot be edited/deleted.
2. Duplicating a built-in produces a valid project bundle; edits survive restart.
3. Invalid YAML never replaces the last valid runnable definition and diagnostics identify the file/line.
4. Polly creates isolated implementation/review workspaces and cannot merge.
5. Debby displays independent Claude/Codex answers, critique rounds, and synthesis.
6. Harness follows the PIV stages and preserves independent testing/verification evidence.
7. Cancelling or taking over revokes orchestration immediately but leaves worktrees inspectable.
8. A scheduled task uses its stored revision after the source agent is edited.
9. Existing ordinary turns and scheduled tasks behave identically with no selected agent.
10. Packaged-app smoke test resolves built-in resources and starts the stdio proxy successfully.

## Acceptance Criteria

- [ ] The app ships immutable, valid Polly, Debby, and Harness built-ins, with attribution and explicit provider requirements.
- [ ] A user can duplicate, import, create, validate, edit, and recoverably delete project-scoped custom bundles from the Agents UI.
- [ ] The documented safe YAML subset supports root/child prompts, instruction files, skills, provider selection, agent references, and bounded policies; executable unsupported fields are rejected.
- [ ] Every manual or scheduled run persists the exact validated snapshot/digest it executed.
- [ ] A coordinator can dispatch, continue, await, and cancel direct children through a capability-scoped MCP server, and cannot access generic IPC/filesystem/database/merge authority.
- [ ] All coordinator and child provider turns run through `HarnessSupervisor` in isolated, claimed workspaces created by `WorkspaceManager`.
- [ ] Fan-out, parallelism, nesting, role/provider, time, request, response, and total-run limits are enforced in main, independent of prompts.
- [ ] Polly enforces independent-provider review and leaves PR-ready work for human merge.
- [ ] Debby preserves and displays both independent responses, bounded critique rounds, and final synthesis.
- [ ] Harness represents the repository's PIV workflow with independently authored tests, verification, and review stages.
- [ ] Agents is an accessible peer tab to Tasks and Knowledge; Knowledge remains non-executable reference material.
- [ ] Scheduled tasks can select an agent, preserve a snapshot, report staleness, and reconcile interruption without changing existing no-agent behavior.
- [ ] Cancellation, takeover, crash recovery, and shutdown revoke all tokens/sockets, interrupt active processes exactly once, release claims, and preserve worktrees.
- [ ] Shared IPC changes are append-only; renderer hardening remains intact; all handlers use the normalized error boundary.
- [ ] Migration 0015 passes upgrade and rollback tests and includes a clear back-compat/data-loss note.
- [ ] Deterministic E2E proof and the full harness gate pass, including named heightened-scrutiny review of IPC, MCP/process, filesystem, git/worktree, DB, and secret boundaries.

