# Plan: Phase 4 — Diff Viewer, Review Loop & Checkpoints

## Ticket / Feature
Make the review loop first-class: live worktree-vs-merge-base diff + full Monaco diff viewer, inline
comments that become `diff_comment` agent attachments, a one-click agent review action, per-turn
`git commit-tree` checkpoints with revert, and a `todos` table fed by agent `todo_update` events
(`docs/implementation-plan/phase-4-diff-review-checkpoints.md`).

## Complexity
**High.** Cross-cutting across `git`, `diff`, `checkpoint`, `db`, `harness`, `ipc`, `settings`, and a
new renderer feature. Touches **four** heightened-scrutiny paths at once (git/fs on user workspaces,
the IPC/preload boundary, a DB migration, and destructive worktree ops). The frozen Phase-0 stubs give
us the signatures; the risk is in the git plumbing (temp-index snapshots, non-branch-moving revert) and
keeping `src/shared/**` append-only.

---

## Design decisions (recorded — sensible defaults chosen, not blocking)
These are internal choices the ticket leaves open. Defaults picked; revisit only if a reviewer objects.

1. **`review:run` / `comment:sendToAgent` do NOT start turns themselves.** Turns flow over the
   `turn:start` **stream** (Phase 2), not a command. So these commands *prepare* the turn and return the
   payload; the renderer feeds it into the existing `useChat.sendTurn`. `comment:sendToAgent` returns the
   built `Attachment[]` and marks the comments `sent`; `review:run` returns the composed review `prompt`.
   This respects the architecture and avoids a second turn-driver.
2. **Review-turn "tagging" is client-side, not persisted.** Annotating review output "grouped by file"
   would need a `turns.kind` column. To keep migration `0005` to the three named tables (+ the one
   `turns.reverted_at` column revert needs), the renderer marks the turn it just launched via `review:run`
   as a review turn in local state for styling. Lost on reload — acceptable MVP; a `turns.kind` column is a
   future migration. Documented in the diff `CLAUDE.md`.
3. **Chat truncation on revert = a `turns.reverted_at` column** (ALTER TABLE in `0005`). Reverted turns keep
   their rows but are filtered out of history and out of `latestSessionId`, so the **next turn starts a fresh
   session** (satisfies "CLI sessions can't be truncated mid-stream"). `revert` returns `void` (stub
   signature); the summary-seeding of a fresh turn is left to the renderer (compose from retained turns).
4. **Revert restores the worktree WITHOUT moving the branch and WITHOUT `git clean`** (the `security-guard`
   hook hard-blocks `git clean -d/-f/-x`; also we must not touch branch history). Approach: scratch-index
   `read-tree <ref>` → `checkout-index -a -f`, then delete files present in the worktree but absent from the
   target tree by walking `git diff --name-status <ref> <HEAD>` and `fs.rm`-ing only those exact paths
   (confined to the worktree root). See Task 8 gotcha.
5. **`diff:get` returns a lightweight shared `DiffSet` (files + refs, no patch).** Monaco gets per-file
   old/new content lazily via `diff:file`, keeping the list payload small for monorepos (spec §9).

---

## Affected Files

### Read before implementing
- `src/main/git/index.ts` (L42–64 `DiffFile`/`GitDiff` frozen; L631–669 Phase-4 stubs `status`/`diff`/
  `commitTree`/`updateRef`/`resetHard`) — the git primitives to implement; **frozen interfaces DO NOT modify**.
- `src/main/git/index.test.ts` (L1–70) — temp-repo test harness style (`g()` helper, `mkdtempSync`, real git).
- `src/main/diff/index.ts` (whole) — DiffService stub + `DiffComment`/`NewDiffComment`/`DiffCommentState`/
  `DiffWatchHandle` shapes to preserve.
- `src/main/checkpoint/index.ts` (whole) — CheckpointService stub + `Checkpoint` shape.
- `src/main/harness/supervisor.ts` (L49–58 deps, L149–164 push, L261–294 `finalize`) — the terminal hook
  point for checkpoint-snapshot / diff-recompute / todo-persist.
- `src/main/harness/turns.ts` (L69–83 `beginTurn`, L150–156 `history`) — turn idx allocation + history shape.
- `src/main/db/schema.ts`, `src/main/db/migrations/0003_turns_events.ts`, `src/main/db/migrations/index.ts`,
  `src/main/db/repos/turns.ts`, `src/main/db/repos/events.ts` — migration + repo + row↔DTO patterns to mirror.
- `src/shared/ipc.ts` (L82–213 `Commands`/`Events`/`StreamChannels`), `src/shared/models.ts`,
  `src/shared/harness.ts` (L49–60 `Attachment`, L105–111 `Todo`) — the frozen append-only contract.
- `src/main/ipc/register.ts` (L74–90 `handle`, L211–278 `turn:start` producer, L551–676 Phase-2/3 handlers) —
  handler + validation + error-boundary pattern to mirror.
- `src/preload/index.ts` (L79–106) + `src/renderer/ipc/index.ts` (whole) — the bridge is generic; no per-channel
  edits needed (verify), but read to confirm.
- `src/main/index.ts` (L190–291 `createAppContext`, L419–435 before-quit) — service construction + teardown wiring.
- `src/main/settings/schema.ts` (L104–128 `agentSchema`) — where the review-prompt default is added.
- `src/renderer/features/chat/useChat.ts`, `src/renderer/stores/chat.ts`, `src/renderer/app/AppLayout.tsx`,
  `src/renderer/features/chat/ChatPanel.tsx` — renderer feature + store + stream-consumption patterns to mirror.

### Modify
- `src/main/git/index.ts` — implement `status`, `diff`, `commitTree` (add optional `parents?: string[]`),
  `updateRef`, `resetHard`; add internal hunk-parse helpers. **Do not touch the frozen interface blocks.**
- `src/main/diff/index.ts` — implement DiffService; import shared DTOs (below) instead of local decls; add
  `fileDiff`, `commits`, `removeComment`, `buildSendToAgent`, `reconcileComments`; construct with deps.
- `src/main/checkpoint/index.ts` — implement CheckpointService; import shared `Checkpoint`; construct with deps.
- `src/main/db/schema.ts` — append `CheckpointsTable`, `DiffCommentsTable`, `TodosTable`; add
  `reverted_at: number | null` to `TurnsTable`; add the three keys to `Database`.
- `src/main/db/migrations/index.ts` — import + append `migration0005DiffReview` (version 5).
- `src/main/harness/supervisor.ts` — append optional deps `onTurnEnd?`, `onTodoUpdate?`; call `onTodoUpdate`
  on a `todo_update` event (has `workspaceId`), and `onTurnEnd(workspaceId, turnId)` at the end of `finalize`.
- `src/shared/ipc.ts` — **append** the new `Commands` entries + new DTO imports (see Task 3).
- `src/main/ipc/register.ts` — add the new command handlers (validate/narrow every input).
- `src/main/index.ts` — construct `DiffService`/`CheckpointService` with deps; new `TodosRepo`; wire
  `onTurnEnd`/`onTodoUpdate` into the supervisor; tear down diff watchers in `before-quit`.
- `src/main/settings/schema.ts` — add `agent.reviewPrompt` (string, sensible default).
- `src/renderer/app/AppLayout.tsx` — add a `diff` center tab (or right-pane) mounting the diff feature.
- `src/renderer/ipc/index.ts`, `src/preload/index.ts` — verify generic bridge covers the new channels (expected: no change).

### Create
- `src/shared/review.ts` — **new** append-only shared DTO module (import-safe both sides): `DiffSet`,
  `DiffFileEntry`, `FileDiff`, `DiffHunk`, `DiffCommentState`, `DiffComment`, `NewDiffComment`, `CommitInfo`,
  `Checkpoint`, `TodoInput`, `SendToAgentResult`, `ReviewPrompt`. Re-exported by main/diff + main/checkpoint.
- `src/main/db/migrations/0005_diff_review.ts` — the migration (3 tables + indexes + `turns.reverted_at`).
- `src/main/db/repos/comments.ts` — `DiffCommentsRepo` (CRUD, row↔DTO).
- `src/main/db/repos/checkpoints.ts` — `CheckpointsRepo` (create/list, row↔DTO).
- `src/main/db/repos/todos.ts` — `TodosRepo` (list/create/toggle/replaceAgentTodos).
- Tests: `src/main/git/diff.test.ts`, `src/main/git/checkpoint-plumbing.test.ts` (or extend `index.test.ts`),
  `src/main/diff/index.test.ts`, `src/main/checkpoint/index.test.ts`, `src/main/db/repos/comments.test.ts`,
  `src/main/db/repos/todos.test.ts`, `src/main/db/migrations/0005_diff_review.test.ts`.
- Renderer feature `src/renderer/features/diff/`: `DiffPanel.tsx`, `FileTree.tsx`, `DiffView.tsx`
  (Monaco `DiffEditor`), `CommentRail.tsx`, `CommitFilter.tsx`, `CheckpointTimeline.tsx`, `useDiff.ts`,
  `useCheckpoints.ts`, `DiffPanel.test.tsx`; store `src/renderer/stores/diff.ts`.

---

## Ordered Tasks

> Dependency order: **foundation (1→3)** must land before the module work (4–9). Modules 4/5, 6, 7 are
> largely independent once the foundation exists; IPC (9) depends on all services; UI (10–11) depends on IPC.

### Task 1 — Migration `0005_diff_review` + schema types
- What: Create `checkpoints`, `diff_comments`, `todos` (spec §3) with `workspace_id` indexes, plus
  `ALTER TABLE turns ADD COLUMN reverted_at INTEGER`. Append `CheckpointsTable`/`DiffCommentsTable`/
  `TodosTable` + the `Database` keys to `schema.ts`; add `reverted_at: number | null` to `TurnsTable`.
  Register `migration0005DiffReview` (version 5) in `migrations/index.ts`.
- Columns: `diff_comments(id, workspace_id, file_path, line_start, line_end, side, body, state, created_at)`;
  `checkpoints(id, workspace_id, turn_id, ref_name, sha, created_at)`; `todos(id, workspace_id, body,
  done INTEGER, source, created_at, updated_at)`. Booleans as INTEGER 0/1 (`todos.done`) per schema.ts convention.
- Pattern: `src/main/db/migrations/0003_turns_events.ts` — raw `db.exec` DDL + a ROLLBACK/BACK-COMPAT note in
  the header. Rollback: `DROP TABLE todos; DROP TABLE diff_comments; DROP TABLE checkpoints;` (turns column is
  additive — `reverted_at` left in place is harmless on downgrade; note it).
- Gotcha: **DB migration is a heightened-scrutiny path** — SQLite is on the user's disk; the migration must be
  purely additive (0001/0003 untouched) and the runner bumps `user_version` in-transaction. Version numbers are
  already non-contiguous (1,3) so 5 is fine; keep it named by phase.
- Validate: `node scripts/vitest-electron.mjs run src/main/db/migrations/0005_diff_review.test.ts`

### Task 2 — GitService diff + checkpoint plumbing
- What: Implement `status`, `diff(worktreePath, baseRef)`, `commitTree(worktreePath, message, parents?)`
  (add optional `parents?: string[]` — additive), `updateRef`, `resetHard`. Add a private unified-diff hunk
  parser producing `{ oldStart, oldLines, newStart, newLines, lines }`.
- `diff`: `git -C <wt> diff --name-status <base>` + `--numstat <base>` merged into `GitDiff.files` (worktree
  vs base incl. uncommitted); `patch` from `git -C <wt> diff <base>`. Handle renames (`R100 old new`) and
  deletes; map to the frozen `DiffFile` shape.
- `commitTree`: use a **scratch index** — `GIT_INDEX_FILE=<tmp> git -C <wt> read-tree HEAD`, then
  `... add -A`, `... write-tree`, then `git -C <wt> commit-tree <tree> [-p <parent>]* -m <msg>` with committer
  identity env. **Never** touch the real index (ticket §8).
- `resetHard`: for revert — scratch-index `read-tree <ref>` + `checkout-index -a -f`, then delete worktree
  files absent from the target tree (from `git diff --name-status <ref> HEAD`, status `A` → the file exists now
  but not in ref) via `fs.rm` on each exact path confined to the worktree. **No `git clean`, no branch move.**
- Pattern: existing GitService methods — arg arrays via `execa`, `toGitError` wrapping, `-C <path>` targeting.
- Gotcha: **git/fs on user workspaces = heightened scrutiny.** Confine every path to the worktree root; reject
  traversal; `resetHard` is destructive (caller does confirm + auto-backup). Set `GIT_INDEX_FILE` per-call, never
  globally. Tests set `-c user.email/-c user.name`; `commit-tree` needs `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env.
- Validate: `node scripts/vitest-electron.mjs run src/main/git/diff.test.ts`

### Task 3 — Shared DTOs (`src/shared/review.ts`) + IPC contract append
- What: Create `src/shared/review.ts` with the cross-boundary DTOs (see Create list). **Append** to
  `Commands` in `src/shared/ipc.ts`: `diff:get`, `diff:file`, `diff:commits`, `comment:create`, `comment:list`,
  `comment:resolve`, `comment:remove`, `comment:sendToAgent`, `review:run`, `checkpoint:list`,
  `checkpoint:revert`, `todo:list`, `todo:create`, `todo:toggle`. `diff:changed` **already exists** in `Events`
  (L165, reserved) — do not re-add.
- Pattern: `src/shared/ipc.ts` Phase-3 append block (L121–137) — one commented `{ req; res }` line per channel;
  import DTOs from `@shared/review`. Move `DiffComment`/`Checkpoint`/etc. into `@shared/review` and have
  `src/main/diff` + `src/main/checkpoint` re-export from there (preserve shapes exactly).
- Gotcha: `src/shared/**` is **FROZEN, append-only** — new entries only, never reorder/rename. `@shared/review`
  must be import-safe from both processes (no `electron`, no Node, no DOM). `GitDiff`/`DiffFile` stay in
  `src/main/git` (main-only); the IPC handler maps `GitDiff → DiffSet` (Task 9).
- Validate: `bash ci/harness-gates.sh typecheck`

### Task 4 — DiffService (compute + watch + cache)
- What: Implement `getDiff` (worktree vs `mergeBase(HEAD, origin/<baseBranch>)`; add optional `commitFilter?`),
  `fileDiff(workspaceId, path)` (old content via `git show <base>:<path>`, new from the worktree file, + parsed
  hunks), `commits(workspaceId)` (`git log <base>..HEAD`), `watch(workspaceId)` (chokidar, ignore
  `.git`/`node_modules`/`dist`, debounce ~300ms → `emit('diff:changed', { workspaceId })`). Simple in-memory
  cache keyed on `(HEAD sha, status signature)`; invalidate on watcher fire.
- Construct `DiffService({ git, getWorkspace, emit, comments: DiffCommentsRepo })`. Start a watcher lazily on
  first `diff:get` for a workspace (idempotent Map keyed by workspaceId); expose `stopAll()` for quit teardown.
- Pattern: `chokidar` is already a dep; `emit` closure mirrors `main/index.ts` L206–215; watcher teardown mirrors
  `DiffWatchHandle.stop()`.
- Gotcha: `fileDiff` path is **untrusted** — resolve against the worktree root and reject `..`/absolute escapes
  before `git show`/fs read (path traversal). Debounce must coalesce editor save storms. Recompute is also
  triggered on `turn_end` (Task 8), so the watcher and the hook must not double-emit destructively (idempotent).
- Validate: `node scripts/vitest-electron.mjs run src/main/diff/index.test.ts`

### Task 5 — Inline comments (repo + service)
- What: `DiffCommentsRepo` CRUD (row↔DTO like `turns.ts`). DiffService: `addComment` (→`open`), `listComments`
  (optional state filter), `setCommentState`, `removeComment`; `buildSendToAgent(workspaceId)` → collect `open`
  comments, build `Attachment{ type:'diff_comment', file, lineStart, lineEnd, side, excerpt, body }` (excerpt from
  `fileDiff` hunks), mark them `sent`, return `SendToAgentResult{ attachments }`; `reconcileComments(workspaceId)`
  → for each `sent` comment, if the referenced lines changed vs the fresh `fileDiff`, flip `sent`→`resolved`
  (conservative heuristic — document it).
- Pattern: `Attachment` shape is **frozen** in `@shared/harness` L49–60 — build it exactly (note: frozen
  `diff_comment` requires non-null `lineStart`/`lineEnd`/`side`/`excerpt`; DB allows null → skip/guard comments
  without a resolvable range when building attachments).
- Gotcha: auto-resolve can mis-fire (ticket §8) — keep it conservative; users can re-open. Test the exact
  attachment shape against the Phase-2 contract (DoD item).
- Validate: `node scripts/vitest-electron.mjs run src/main/db/repos/comments.test.ts`

### Task 6 — CheckpointService (snapshot + revert)
- What: `CheckpointsRepo` (create/list). `snapshot(workspaceId, turnId)`: resolve worktree + turn idx (via
  `TurnsRepo.getById`), `git.commitTree(wt, msg, [prevCheckpointSha])` → `git.updateRef(wt,
  refs/checkpoints/<ws>/<idx>, sha)` → insert row. `list(workspaceId)` ordered by turn idx. `revert(workspaceId,
  turnIdx)`: **auto-backup** current state (snapshot to `refs/checkpoints/<ws>/backup/<ts>` + row) → resolve
  target ref → `git.resetHard(wt, ref)` → mark `turns.reverted_at` for idx > turnIdx (`TurnsRepo.markRevertedAfter`).
- Construct `CheckpointService({ git, getWorkspace, checkpoints: CheckpointsRepo, turns: TurnsRepo })`.
- Pattern: ref names `refs/checkpoints/<ws>/<idx>` (ticket §3.4); UUIDv7 workspace ids are ref-name-safe.
- Gotcha: **destructive worktree op = heightened scrutiny + mandatory verifier.** `snapshot` must never move the
  branch; `revert` backs up first, never `git clean`, never touches branch history. `refs/checkpoints/*` must be
  excluded from normal branch/PR ops (Phase 5 concern — note it; don't push them). Reverting twice must be safe
  (idempotent-ish). `latestSessionId` must exclude reverted turns so the next turn is fresh (Task 8 / TurnsRepo).
- Validate: `node scripts/vitest-electron.mjs run src/main/checkpoint/index.test.ts`

### Task 7 — Todos (repo + agent persistence)
- What: `TodosRepo` — `list(workspaceId)`, `create(TodoInput)` (`source:'user'`), `toggle(id)`,
  `replaceAgentTodos(workspaceId, Todo[])` (upsert the agent's todo set, `source:'agent'`). `done` stored as
  INTEGER 0/1; map to `Todo` DTO (`@shared/harness`).
- Pattern: `turns.ts` repo; `Todo` DTO already frozen in `@shared/harness` L105–111.
- Gotcha: `todo_update` events arrive during a turn — persisted via the supervisor `onTodoUpdate` hook (Task 8),
  not here. Keep the repo pure CRUD.
- Validate: `node scripts/vitest-electron.mjs run src/main/db/repos/todos.test.ts`

### Task 8 — Supervisor hooks (turn_end → checkpoint + diff recompute + todos)
- What: Append **optional** deps to `HarnessSupervisorDeps`: `onTodoUpdate?: (workspaceId, todos) => void` and
  `onTurnEnd?: (workspaceId, turnId) => void`. In `wrapped.push`, when `event.kind === 'todo_update'` call
  `onTodoUpdate(workspaceId, event.todos)`. At the end of `finalize` (after the status flip), fire
  `onTurnEnd(workspaceId, live.turnId)`. Add `TurnsRepo.markRevertedAfter(workspaceId, idx)` and make
  `latestSessionId` ignore reverted turns (`where reverted_at is null`).
- Wire in `main/index.ts`: `onTodoUpdate → todosRepo.replaceAgentTodos`; `onTurnEnd → checkpoint.snapshot(...)`
  then `diff` cache-invalidate + `emit('diff:changed')` + `diff.reconcileComments(...)`. Guard each with
  try/catch + log (mirrors supervisor's `logFinalizeError`) so a checkpoint/diff failure never wedges a turn.
- Pattern: `supervisor.ts` L149–164 (push) + L261–294 (finalize); optional deps are additive (the **public method
  signatures** stay frozen — only the deps interface grows).
- Gotcha: **heightened scrutiny (process lifecycle).** The single-turn invariant is load-bearing — the hooks run
  AFTER `registry.delete`, inside the write-chain, and must not throw into the supervisor. `onTurnEnd` runs the
  checkpoint snapshot off the finalize path; keep it best-effort.
- Validate: `node scripts/vitest-electron.mjs run src/main/harness/supervisor.test.ts`

### Task 9 — IPC handlers (the 14 new commands)
- What: Add handlers in `register.ts` for every Task-3 channel. `diff:get` → `ctx.diff.getDiff` mapped to
  `DiffSet`; `diff:file`/`diff:commits` → DiffService; `comment:*` → DiffService/`DiffCommentsRepo`;
  `comment:sendToAgent` → `ctx.diff.buildSendToAgent`; `review:run` → compose `settings.agent.reviewPrompt` +
  `DiffSet` summary into `ReviewPrompt{ prompt }`; `checkpoint:list`/`checkpoint:revert` → CheckpointService;
  `todo:*` → TodosRepo. Ensure `diff:get` starts the watcher (idempotent).
- Pattern: `register.ts` `handle(...)` + per-handler input validation (L554–676). Every handler validates:
  `workspaceId` non-empty string; `diff:file` path is a non-empty relative path (traversal rejected in the
  service); `checkpoint:revert` turnIdx is a non-negative integer; comment fields typed/narrowed.
- Gotcha: **IPC/preload boundary = heightened scrutiny.** Treat all payloads as untrusted; never interpolate into
  shell strings (git goes through GitService arg arrays). The generic preload/renderer bridge needs **no**
  per-channel edits — verify `invoke` covers them (it's typed off `Commands`). Adding to `Commands` is enough.
- Validate: `bash ci/harness-gates.sh typecheck lint`

### Task 10 — Diff viewer UI (feature + store + hooks)
- What: `src/renderer/features/diff/` — `DiffPanel` (orchestrator), `FileTree` (A/M/D badges + +/- stats),
  `DiffView` (Monaco `@monaco-editor/react` `DiffEditor`, side-by-side + unified toggle, large-file lazy-hunk
  guard), `CommitFilter` (`base..HEAD` selector), `CommentRail` (open comments + per-comment resolve + bulk
  "Send to agent"), gutter comment popover. `useDiff` hook: fetch `diff:get`/`diff:file`/`diff:commits`,
  subscribe `diff:changed` (refetch), comment CRUD. Store `stores/diff.ts` (Zustand) per workspace.
- "Send to agent": call `comment:sendToAgent`, then feed returned `attachments` into the chat feature's
  `sendTurn` (reuse `useChat`). "Agent review": call `review:run`, feed `prompt` into `sendTurn` (mark local
  review-turn flag for annotation styling — decision 2).
- Pattern: `useChat.ts` (stream/hydrate), `stores/chat.ts` (Zustand), `AppLayout.tsx` (tab wiring); all IPC via
  `@renderer/ipc` — never `window.api` directly. `@monaco-editor/react`/`monaco-editor`/`shiki` are already deps.
- Gotcha: `onEvent('diff:changed')` subscription must unsubscribe on unmount/workspace change (no listener leak —
  mirror `useChat`'s abort pattern). Large diffs: virtualize the tree / lazy per-file `diff:file` (spec §9).
- Validate: `node scripts/vitest-electron.mjs run src/renderer/features/diff/DiffPanel.test.tsx`

### Task 11 — Checkpoint timeline UI + layout wiring + settings
- What: `CheckpointTimeline` (per-turn checkpoints, "revert to here" with a confirm dialog explaining
  backup + session reset), `useCheckpoints` (`checkpoint:list`/`checkpoint:revert`). Add a **Diff** center tab
  (or right-pane) in `AppLayout.tsx` mounting `DiffPanel`. Add `agent.reviewPrompt` default to
  `settings/schema.ts`. Document the revert chat-truncation behavior in-UI (dialog copy).
- Pattern: `AppLayout.tsx` `CENTER_TABS` (L29–32); confirm-dialog copy explains auto-backup + fresh session.
- Gotcha: the revert confirm is the user's safety gate for a destructive op — copy must be explicit about the
  worktree reset + chat truncation + new session.
- Validate: `node scripts/vitest-electron.mjs run src/renderer/features/diff/DiffPanel.test.tsx`

### Task 12 — Docs
- What: Update/create `src/main/diff/CLAUDE.md` and `src/main/checkpoint/CLAUDE.md` with the non-obvious
  behaviors: cache key, auto-resolve heuristic, scratch-index snapshot, non-branch-moving revert, `refs/checkpoints/*`
  exclusion, review-turn-not-persisted, `reverted_at` semantics. Note the `0005` rollback in the migration header.
- Validate: n/a (prose) — covered by the DoD "documented in nearest CLAUDE.md".

---

## Execution Strategy
*How `/harness-implement` should build this. `/harness-implement` reads this verbatim.*
- **Task shape:** Cross-cutting, multi-module, **high-stakes** — hits four heightened-scrutiny paths (git/fs on
  user workspaces, IPC/preload boundary, DB migration, destructive worktree revert). High complexity, ~2 weeks.
- **Pattern:** prompt-chaining for the **foundation** (Tasks 1–3 sequential — migration + git plumbing + shared
  contract gate everything) → **parallelization (sectioning)** for the independent modules (Tasks 4/5 diff, 6
  checkpoint, 7 todos) → prompt-chaining again for the convergence (8 hooks → 9 IPC → 10/11 UI) →
  **evaluator-optimizer + mandatory verifier** on the git/fs + revert + migration paths.
- **Agents:** `coder` (foundation) → then per-section `coder` (diff · checkpoint · todos) each paired with a
  `test-author` → `coder` (IPC + supervisor hooks) → `frontend-designer`/`coder` (diff UI) → **`code-review`
  + `verifier` (mandatory)** on Tasks 2, 6, 8, 9 (the heightened-scrutiny surface).
- **Orchestration:** prefer **team** if `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is enabled (each teammate owns a
  section via the shared task list, no file conflicts), else **parallel subagents** for the independent sections
  and **sequential** for the foundation + convergence.
- **Parallel decomposition + file-ownership:**
  - *Sequential foundation (no overlap):* Task 1 owns `db/migrations/0005*`, `db/schema.ts`,
    `db/migrations/index.ts`. Task 2 owns `git/index.ts` (+ git tests). Task 3 owns `shared/review.ts` +
    `shared/ipc.ts`. Land these first — everything else imports them.
  - *Parallel sections (independent files):* **Diff** owns `main/diff/*`, `db/repos/comments.ts`;
    **Checkpoint** owns `main/checkpoint/*`, `db/repos/checkpoints.ts`; **Todos** owns `db/repos/todos.ts`.
  - *Serialized convergence (shared files — one owner each, in order):* Task 8 owns `harness/supervisor.ts`
    + `db/repos/turns.ts`; Task 9 owns `ipc/register.ts`; Task 10/11 own `renderer/features/diff/*`,
    `stores/diff.ts`, `AppLayout.tsx`, `settings/schema.ts`. `main/index.ts` is touched by the convergence —
    **single owner, last** — to avoid conflicts.
- **Rationale:** the migration + git primitives + shared contract are a hard dependency for every module, so they
  must be sequential and first; the three services are genuinely independent (different files) and parallelize
  cleanly; the destructive git paths demand a mandatory independent verifier, so those tasks get the
  evaluator-optimizer treatment rather than a single-pass coder.

---

## Validation Gate
Run after all tasks (from repo root):
```
bash ci/harness-gates.sh format lint typecheck   # fast inner loop
bash ci/harness-gates.sh                          # full gate before PR (npm run check: tsc -b + eslint + vitest + electron-vite build)
```
Per-task Vitest commands are listed inline above. All main-process tests use temp-dir real-git repos and
temp-file SQLite (`openDb(path)`), no Electron runtime; renderer tests use the MockHarness + jsdom.

## Acceptance Criteria
- [ ] Diff shows worktree-vs-merge-base with correct A/M/D + stats; updates live on file change and after each turn.
- [ ] Side-by-side and unified render with syntax highlighting (Monaco); commit filter scopes the diff.
- [ ] Inline comments → "Send to agent" → next turn receives them as `diff_comment` attachments matching the
      frozen Phase-2 `Attachment` shape; comments auto-resolve when the referenced lines change.
- [ ] "Agent review" runs a review turn from `settings.agent.reviewPrompt` + the current diff summary.
- [ ] Each `turn_end` writes a `refs/checkpoints/<ws>/<idx>` ref (visible in the timeline) without altering
      branch history; the checkpoint commit is reachable only via its ref, not from the branch.
- [ ] Revert to turn N restores worktree files (incl. deleting files added after the checkpoint, no `git clean`,
      no branch move), auto-backs up current state, marks later turns reverted, and the next turn starts a fresh
      session; reverting twice is safe.
- [ ] Agent `todo_update`s persist to `todos(source='agent')` and list; user todos create/toggle.
- [ ] Migration `0005` applies cleanly on a fresh DB and is a no-op on re-run; `src/shared/**` changes are
      append-only; renderer hardening intact (no per-channel preload edits).
- [ ] All Validation Gate blocking gates pass (run /verify); heightened-scrutiny paths (Tasks 2, 6, 8, 9) got a
      named review + independent verifier.
```
```
