# Plan: Phase 1 — Workspace Engine (Electron)

## Ticket
Phase 1 of the Parallel Coding Agents app (`docs/implementation-plan/phase-1-workspace-engine.md`,
spec §2.3/§3/§5.1/§8-M1). Turn the Phase-0 stubs into a working backbone: a real **GitService** (clone /
fetch / worktree lifecycle / ref queries over the system `git` binary via **execa**), a real
**WorkspaceManager** (create / archive / restore, sole status writer, city-name + port allocation,
setup-script streaming), the IPC surface those need, and the **sidebar/dashboard UI** (project switcher,
workspace list with live status badges, create dialog with streamed setup log, archive/restore). No new
subsystems beyond Phase 1's owned directories; everything else stays a Phase-0 stub.

## Context: what Phase 0 already froze (build against these, don't re-litigate)
- **Shared contracts are append-only** (README §5.2): `src/shared/**`. Phase 1 *adds* `Commands` /
  `StreamChannels` entries and DTOs; it never rewrites existing ones.
- **DB layer is done and correct.** `openDb()` (`src/main/db/index.ts:39`), the `0001_core` migration
  (`projects` + `workspaces` with the **unique** `(project_id, name)` index —
  `src/main/db/migrations/0001_core.ts:47`), and both repos (`ProjectsRepo`
  `src/main/db/repos/projects.ts:36`, `WorkspacesRepo` `src/main/db/repos/workspaces.ts:74` with
  `create/getById/listByProject/setStatus/update`) already return `@shared/models` DTOs. **Reuse the
  repos — do not write SQL in WorkspaceManager.**
- **IPC framework is done.** `handle()` error boundary + the `streamProducers` registry
  (`src/main/ipc/register.ts:66,101`), `createStream()` / `createMessageChannelStream()`
  (`src/main/ipc/stream.ts:101,257`), typed `emit`/`emitAll` (`src/main/ipc/events.ts:19,34`), the preload
  `window.api`, and the renderer funnel `invoke/onEvent/subscribeStream` (`src/renderer/ipc/index.ts`).
  The `streamProducers` object is a **mapped type over every `StreamChannel`** — adding a `StreamChannels`
  entry forces a producer here (tsc-enforced exhaustiveness). That is Phase 1's stream wiring seam.
- **Events `workspace:status` / `workspace:created` / `workspace:archived` are already typed and frozen**
  (`src/shared/ipc.ts:62`). Phase 1 *emits them for real* — no new event names needed.
- **`AppError`** shape (`@shared/errors`): construct `new AppError('git', msg, { stderr })`; it round-trips
  the IPC boundary. GitService/WorkspaceManager throw typed `AppError`s (README §7.2).
- **paths.ts is the only on-disk-location module** and has a test seam (`setUserDataRoot`
  `src/main/paths.ts:28`, `repoDir():85`, `worktreesDir():90`, `worktreeDir():95`).
- **Settings are read-only and merged** — read via `ctx.settings.get()`
  (`src/main/settings/index.ts:125`): `scripts.setup` / `scripts.archive` / `scripts.run`,
  `git.branchPrefix` (default `'agent'`), `env`, `agent.defaultHarness` (default `'claude_code'`).
- **No root or nested `CLAUDE.md` exists** in this repo; the binding docs are README + the phase file +
  the Phase-0 plan (`plans/phase-0-foundation-plan.md`). `git 2.50.1` is on PATH; `execa`, `simple-git`,
  `uuid` are installed. Tests run under the **Electron ABI** via `scripts/vitest-electron.mjs` (node env
  by default; `src/renderer/**/*.test.tsx` → jsdom).

---

## Affected Files

### Read before implementing (context — do not modify)
- `docs/implementation-plan/phase-1-workspace-engine.md` — the per-task detail this plan operationalizes.
- `docs/implementation-plan/README.md` — §6.2 IPC contract (L229–261), §6.4 status machine (L312–317),
  §5 parallelization/ownership (L180–201), §7 conventions (L328–366).
- `src/main/git/index.ts` — the GitService stub to fill/extend (methods at :70/:75/:83/:96/:121; the diff/
  checkpoint methods :105/:113/:135/:140/:152 stay throwing — Phase 4).
- `src/main/workspace/index.ts` — the WorkspaceManager stub + `CreateWorkspaceOptions` (:18) to fill.
- `src/main/db/repos/{workspaces,projects}.ts` — the CRUD to call (don't reimplement).
- `src/main/ipc/register.ts` (:66 `handle`, :101 `streamProducers`, :174 `registerIpc`) — the append point
  for new commands + stream producers.
- `src/main/ipc/stream.ts` (:101 `createStream`) + `src/main/ipc/events.ts` (:19 `emit`, :34 `emitAll`).
- `src/main/index.ts` (:167 `createAppContext`) — the ONE construction site to rewire.
- `src/shared/ipc.ts` (:42 `Commands`, :93 `StreamChannels`) + `src/shared/models.ts` (:31 `Workspace`).
- `src/renderer/features/sidebar/Sidebar.tsx`, `src/renderer/stores/workspaces.ts` (:39),
  `src/renderer/ipc/index.ts`, `src/renderer/components/IpcHealth.tsx` (mirror for effect/subscribe
  patterns), `src/renderer/app/providers.tsx` (:31 `createQueryClient`), `src/renderer/app/AppLayout.test.tsx`
  (mirror renderer test style).

### Modify (append-only where under `src/shared/`)
- `src/shared/ipc.ts` — APPEND `Commands` (`project:*`, `workspace:*`) + `StreamChannels`
  (`project:clone`, `workspace:create`) entries and their payload types. Never touch existing entries.
- `src/shared/models.ts` — APPEND `CreateWorkspaceReq` DTO (+ optional `RepoInfo` if surfaced to renderer).
- `src/main/git/index.ts` — implement Phase-1 method bodies; **add** the methods the phase-doc §3.1 API
  requires that the stub lacks (`open`, `defaultBranch`, `worktreeList`, `branchExists`, `headInfo`) and
  extend `clone` with an optional progress sink. (GitService is Phase-1-owned; signature growth is fine.)
- `src/main/workspace/index.ts` — implement WorkspaceManager; grow the constructor to inject deps.
- `src/main/ipc/register.ts` — APPEND command handlers + the new stream producers.
- `src/main/index.ts` — rewire `createAppContext`: build repos + naming + ports, inject them + a broadcast
  emitter + setup-runner + process-stop hook into `WorkspaceManager`; pass a window accessor for the
  directory-picker command.
- `src/renderer/stores/workspaces.ts` — extend with `selectedProjectId`, project actions, archive/live-
  update reducers (renderer store — editable, Phase 0 said "Phase 1 extends").
- `src/renderer/features/sidebar/Sidebar.tsx` — become the real project/workspace list.

### Create
- `src/main/workspace/naming.ts` — embedded city list + `allocate(existingNames)` (first unused, `-2`
  fallback).
- `src/main/workspace/ports.ts` — `allocate(range, taken)` probe-and-retry a free TCP port.
- `src/main/workspace/setup.ts` — small execa-based setup-command runner streaming to a `SetupLog` sink;
  marked `// INTEGRATION(phase-3): fold into ProcessRunner` (phase doc §3.4).
- `src/renderer/features/sidebar/ProjectSwitcher.tsx`, `WorkspaceItem.tsx`, `StatusBadge.tsx`,
  `NewWorkspaceDialog.tsx`, `AddProjectMenu.tsx`, `SetupLogPanel.tsx` — the UI pieces.
- `src/renderer/features/sidebar/hooks.ts` — TanStack Query hooks (`useProjects`, `useWorkspaces`) +
  event-subscription effect that keeps the cache/store live.
- Tests (Task 8): `src/main/git/index.test.ts` (integration, real git in tmpdir),
  `src/main/workspace/naming.test.ts`, `src/main/workspace/ports.test.ts`,
  `src/main/workspace/index.test.ts` (create→archive→restore cycle), and a renderer sidebar test
  `src/renderer/features/sidebar/Sidebar.test.tsx`.

---

## Ordered Tasks

### Task 1 — GitService: real bodies for the worktree/ref lifecycle
- **What:** Implement over the system `git` binary using **execa** (fine-grained control of `--progress`
  stderr; `simple-git` is the documented fallback). Implement/extend:
  - `clone(originUrl, destPath, onProgress?: StreamSink<CloneProgress>)`: spawn
    `git clone --progress <url> <dest>`, parse stderr lines (`Counting/Compressing/Receiving/Resolving`,
    percent) → push `CloneProgress`. Return the clone path. (Auth: rely on the user's credential helper /
    SSH agent — **no token handling**, Phase 5.)
  - `open(repoPath): RepoInfo` — validate a repo, read `origin` URL (`git -C <p> remote get-url origin`,
    tolerate no remote → `originUrl: ''`) + default branch.
  - `defaultBranch(repoPath)` — resolve `origin/HEAD` symref (`git symbolic-ref refs/remotes/origin/HEAD`),
    fall back to `git remote show origin` / `HEAD` for a local repo with no remote HEAD set.
  - `fetch(repoPath)` — `git -C <p> fetch origin --prune`.
  - `addWorktree(repoPath, worktreePath, branch, baseRef, createBranch)` —
    `git -C <repo> worktree add <path> -b <branch> <base>` (create) or `... worktree add <path> <branch>`
    (checkout existing). **Detect branch-already-exists** before `-b` (see `branchExists`) and pick the
    right form — don't clobber (phase doc §8).
  - `removeWorktree(repoPath, worktreePath, force)` — `git -C <repo> worktree remove [--force] <path>`.
  - `worktreeList(repoPath): WorktreeInfo[]` — parse `git worktree list --porcelain`.
  - `branchExists(repoPath, name): boolean` — `git show-ref --verify --quiet refs/heads/<name>`.
  - `headInfo(worktreePath): HeadInfo` — sha (`rev-parse HEAD`), branch (`rev-parse --abbrev-ref HEAD`),
    ahead/behind vs base (`rev-list --left-right --count <base>...HEAD`).
  - `mergeBase(worktreePath, a, b)` — `git merge-base <a> <b>` (phase-doc API + test §7).
  - Leave `status/diff/commitTree/updateRef/resetHard` **throwing** (Phase 4).
  - Wrap every execa failure → `new AppError('git', <short msg>, { stderr, cmd })` (phase doc §3.1).
  - Add types `CloneProgress`, `RepoInfo`, `WorktreeInfo`, `HeadInfo` (export from this module; put
    `CloneProgress` in `@shared/ipc.ts` too if the renderer renders it — see Task 4).
- **Pattern:** existing stub `src/main/git/index.ts:63`; execa v9 API (ESM, `execa('git', [...], {cwd})`).
- **Gotcha:** execa **v9 is ESM-only** and its error object exposes `.stderr`/`.shortMessage` — read those,
  don't `JSON.stringify(e)`. A **git-not-on-PATH / too-old git** must surface a clear `AppError` (phase
  doc §8 — a startup `git --version` probe is ideal; at minimum wrap ENOENT). `worktree add` prints
  progress to **stderr**, not stdout.
- **Validate:** `npx vitest run src/main/git` (Task 8 integration test against a tmpdir repo).

### Task 2 — Naming + port allocators (pure, unit-tested)
- **What:**
  - `naming.ts`: an embedded city list; `allocate(existingLiveNames: string[]): string` → first city not
    in the set; when exhausted, suffix `-2`, `-3`, … The caller passes the set of **non-archived**
    workspace names for the project (WorkspaceManager derives it from `WorkspacesRepo.listByProject`).
  - `ports.ts`: `allocate(opts?: { range?: [number, number]; taken?: number[] }): Promise<number>` —
    probe a free TCP port via `net.createServer().listen(0)` (or explicit range probing), skipping any in
    `taken` (ports already recorded on live workspaces in the project). Range configurable (spec §9).
- **Pattern:** phase doc §3.2; keep both **pure/injectable** (no DB, no Electron) so they unit-test fast.
- **Gotcha:** port allocation is inherently **TOCTOU** — a port free at probe can be taken before use.
  Mitigate by excluding `taken` and treating the value as a hint the run script may override
  (settings/env). Don't hold the probe socket open.
- **Validate:** `npx vitest run src/main/workspace/naming.test.ts src/main/workspace/ports.test.ts`.

### Task 3 — WorkspaceManager: create / archive / restore + sole status writer
- **What:** Grow the constructor to inject `{ repos: { projects, workspaces }, git, naming, ports,
  settings, runSetup, stopWorkspaceProcesses, emit }` (all wired in Task 6). Implement:
  - **`create(req: CreateWorkspaceReq, log?: StreamSink<SetupLog>)`** (spec §5.1 order, reconciled):
    resolve project → `git.fetch` → allocate name (Task 2) + branch (`<git.branchPrefix>/<name>` unless
    `req.branch`) → resolve baseRef (`req.baseBranch` ?? project.defaultBranch) → `git.addWorktree` (honor
    `branchExists`) → **allocate port** → persist row via `WorkspacesRepo.create` (status `idle`,
    `worktreePath`, `port`, `sourceKind`/`sourceRef` from `req`) → `emit('workspace:created', {workspace})`
    → run `scripts.setup` via `runSetup` streaming to `log`, with env incl. `PORT`/`APP_PORT` + `env`;
    **non-zero exit → `setStatus(needs_attention)`** with the log tail. Return the Workspace.
    *(Reconciliation note: allocate the **port before setup** so the setup script sees `PORT` — the
    phase-doc bullet lists port last, but §3.4 requires PORT in the setup env. Leave a
    `// RECONCILED: port allocated pre-setup so PORT is in the setup env (phase doc §3.3 vs §3.4)` comment.)*
    PR/issue `sourceKind` is **accepted and stored** (existing `source_ref` column); prefill is Phase 5 —
    mark `// INTEGRATION(phase-5): pendingPrompt composer prefill`. **No new migration** (see Risks).
  - **`archive(id)`** (spec §5.1): run optional `scripts.archive` (best-effort) → `stopWorkspaceProcesses(id)`
    (injected no-op hook — `// INTEGRATION(phase-3)`) → `git.removeWorktree(force:true)` → `WorkspacesRepo.update`
    `{ worktreePath: null, status: 'archived', archivedAt: Date.now() }` → **keep all DB rows** →
    `emit('workspace:archived', {workspaceId})`. Force-remove only **after** the stop hook (phase doc §8).
  - **`restore(id)`**: re-add the worktree from the branch; if the branch is gone, attempt recreate from
    the last checkpoint ref (`ctx.checkpoint`, Phase 4) and **degrade gracefully with a clear `AppError`
    if unavailable** — `// INTEGRATION(phase-4)`. Set status back to `idle`, re-fetch DTO, emit
    `workspace:status`. Return the Workspace.
  - **`setStatus(id, status)`** — the **only** status writer (README §6.4): `WorkspacesRepo.setStatus`
    then `emit('workspace:status', {workspaceId, status})`. `running` is an overlay tracked separately
    from the base state (leave the overlay hook for Phase 3; Phase 1 sets the base states).
  - `get`/`list` — delegate to the repos.
- **Pattern:** stub `src/main/workspace/index.ts:39`; repos `src/main/db/repos/workspaces.ts:74`;
  emit `src/main/ipc/events.ts:19`.
- **Gotcha:** better-sqlite3 is **synchronous** — never `await`-race a DB read against the git work;
  sequence git (async) then DB (sync-via-Kysely) deterministically. Do all status changes through
  `setStatus` so exactly one code path emits `workspace:status`. Emit **after** the DB write commits.
- **Validate:** `npx vitest run src/main/workspace/index.test.ts` (create→archive→restore cycle asserts
  filesystem + DB, Task 8).

### Task 4 — Shared contract additions (append-only) + IPC payload types
- **What:** APPEND to `src/shared/ipc.ts`:
  - `Commands`: `project:add {req:{localPath}; res:Project}`, `project:list {req:void; res:Project[]}`,
    `project:pickDirectory {req:void; res:string|null}`, `workspace:list {req:{projectId;
    includeArchived?:boolean}; res:Workspace[]}`, `workspace:get {req:{id}; res:Workspace|null}`,
    `workspace:archive {req:{id}; res:void}`, `workspace:restore {req:{id}; res:Workspace}`.
  - `StreamChannels`: **`project:clone` `{arg:{url}; chunk:CloneProgress}`** and **`workspace:create`
    `{arg:CreateWorkspaceReq; chunk:WorkspaceCreateEvent}`**, where the chunk unions carry progress AND a
    **terminal result frame** so the renderer gets the created row over the same stream (mirrors the
    `app:echoStream` producer shape, no token correlation):
    ```ts
    export type CloneProgress =
      | { phase: 'counting'|'compressing'|'receiving'|'resolving'; percent: number }
      | { phase: 'done'; project: Project };
    export type WorkspaceCreateEvent =
      | { kind: 'phase'; phase: 'fetching'|'worktree'|'port'|'setup'; message?: string }
      | { kind: 'setupLog'; chunk: string }
      | { kind: 'created'; workspace: Workspace };
    ```
  - `workspace:setStatus` stays **main-internal** (driven by subsystems, not the renderer) — no Commands
    entry (phase doc lists it "(internal)").
  - APPEND `CreateWorkspaceReq` to `src/shared/models.ts` and make main's `CreateWorkspaceOptions`
    (`src/main/workspace/index.ts:18`) `= CreateWorkspaceReq` so renderer + main share the request shape.
- **Pattern:** `src/shared/ipc.ts:42` (Commands), `:93` (StreamChannels); existing `SetupLog` sink type
  lives in `@shared/ipc` `StreamSink<T>`.
- **Gotcha:** **append-only** — add entries at the end of each interface; do not reorder. The
  `streamProducers` mapped type (Task 6) will not compile until its two new producers exist — that is the
  intended forcing function.
- **Validate:** `npx tsc -p tsconfig.shared.json --noEmit` clean.

### Task 5 — (folded into Task 3/6) setup-runner module
- **What:** `src/main/workspace/setup.ts`: `runSetup(command, {cwd, env}, sink: StreamSink<SetupLog>):
  Promise<{ exitCode: number }>` — execa the setup command in the worktree, stream combined stdout/stderr
  to `sink`, resolve with the exit code. Short-lived; does **not** use `ProcessRegistry` (that is for
  long-running run scripts). Mark `// INTEGRATION(phase-3): consolidate with ProcessRunner` (phase doc §3.4).
- **Gotcha:** don't duplicate Phase 3's `ProcessRunner`; keep this minimal and clearly seam-marked so the
  Phase-3 agent folds it in rather than finding two runners.
- **Validate:** exercised via Task 3's create test (a trivial `echo` setup script).

### Task 6 — IPC handlers + stream producers + main wiring (convergence)
- **What:**
  - `src/main/ipc/register.ts`: `handle('project:add', …)` → `ctx` project flow (open local repo,
    resolve default branch, `ProjectsRepo.create`); `handle('project:list')`; `handle('project:pickDirectory')`
    → `dialog.showOpenDialog(BrowserWindow.getFocusedWindow() ?? undefined, {properties:['openDirectory']})`;
    `handle('workspace:list'/'get'/'archive'/'restore')` → delegate to `ctx.workspaces`. APPEND two
    `streamProducers` entries: `project:clone` (clone → persist Project → push `{phase:'done', project}`)
    and `workspace:create` (call `ctx.workspaces.create(arg, sinkAdapter)` where the adapter maps
    `SetupLog` → `{kind:'setupLog'}` frames and pushes a final `{kind:'created', workspace}`).
  - `src/main/index.ts` `createAppContext` (:167): construct `new ProjectsRepo(db)` + `new WorkspacesRepo(db)`,
    the naming + ports allocators, a broadcast `emit` closure
    (`(ev,p)=>emitAll(BrowserWindow.getAllWindows().map(w=>w.webContents), ev, p)`), the `runSetup`
    fn, and a `stopWorkspaceProcesses` no-op hook; inject all into `new WorkspaceManager({...})`. Keep
    `GitService` stateless (no deps). Everything else stays a Phase-0 stub.
- **Pattern:** `handle`/`streamProducers` `src/main/ipc/register.ts:66,101`; `emitAll`
  `src/main/ipc/events.ts:34`; construction site `src/main/index.ts:167`.
- **Gotcha:** handlers that need a window (`project:pickDirectory`) must tolerate no focused window. The
  broadcast emitter must skip destroyed WebContents (`emitAll` already does). Do **not** register handlers
  twice — `registerIpc` runs once from `whenReady`.
- **Validate:** `npx tsc -b` clean across all refs; `npm run dev` smoke (Task 8 manual).

### Task 7 — Sidebar / dashboard UI (live status)
- **What:**
  - Extend `stores/workspaces.ts` (:39): add `selectedProjectId`, `setProjects`/`upsertProject`,
    `markArchived(id)`, and keep `upsertWorkspace` for live `workspace:created`/`status` events.
  - `hooks.ts`: `useProjects()` = TanStack Query over `invoke('project:list')`; `useWorkspaces(projectId)`
    over `invoke('workspace:list', {projectId})`; a `useWorkspaceEvents()` effect subscribing via
    `onEvent('workspace:status'|'created'|'archived', …)` to patch the query cache/store (mirror the
    effect+cleanup discipline in `IpcHealth.tsx`).
  - `ProjectSwitcher.tsx` (switch project + `AddProjectMenu` → local dir via `project:pickDirectory` then
    `project:add`, or clone URL → `subscribeStream('project:clone', {url}, …)` with a progress bar).
  - `Sidebar.tsx` / `WorkspaceItem.tsx` / `StatusBadge.tsx`: workspaces grouped by project — name (city),
    branch, **status badge** (idle/working/needs_attention/running/archived), harness icon, port; archived
    rows greyed/collapsed with restore; archive/restore buttons (confirm).
  - `NewWorkspaceDialog.tsx`: base branch, harness, optional custom branch name, source = branch (PR/issue
    tabs **present but disabled** — "coming in integration", Phase 5). On submit,
    `subscribeStream('workspace:create', req, onEvent)` piping `{kind:'setupLog'}` into `SetupLogPanel.tsx`
    and using `{kind:'created'}` to select the new workspace. (⌘⇧N shortcut is Phase 6 — just the button.)
- **Pattern:** `Sidebar.tsx`, `stores/workspaces.ts:39`, funnel `src/renderer/ipc/index.ts:49/64/76`,
  `IpcHealth.tsx` (effect pattern), `providers.tsx:31` (Query client). Tailwind + Radix already wired.
- **Gotcha:** all main access **only** through `src/renderer/ipc/` — never `window.api`/`ipcRenderer`
  directly (README §10). Unsubscribe every `onEvent` on effect cleanup (leaks otherwise). Live updates
  must reconcile with Query cache so a refetch and an event don't fight.
- **Validate:** `npx vitest run src/renderer/features/sidebar` (Task 8 renderer test).

### Task 8 — Tests (author with `test-author`, independent of the code author)
- **What (phase doc §7):**
  - **Git integration** (`src/main/git/index.test.ts`, node env, real `git` in `os.tmpdir()`): init a bare
    origin + clone; assert clone path + default-branch resolution; worktree add/list/remove; `branchExists`;
    `headInfo` ahead/behind; `mergeBase`. Use `paths` seam / explicit paths — no Electron.
  - **Allocators**: `naming.test.ts` (uniqueness + `-2` exhaustion), `ports.test.ts` (returns a free port,
    skips `taken`).
  - **WorkspaceManager** (`src/main/workspace/index.test.ts`): full **create→archive→restore** cycle
    against a temp repo + temp DB (`openDb(tmpPath)`), asserting the worktree exists on disk after create,
    is **gone** after archive, DB rows retained, status `archived` then `idle` after restore; a trivial
    `echo` setup script streams ≥1 `SetupLog` chunk; a non-zero setup → `needs_attention`.
  - **Renderer** (`Sidebar.test.tsx`, jsdom): seeded projects/workspaces render with status badges; a
    mocked `window.api` create-dialog validates input; a `workspace:status` event flips a badge (mirror
    `AppLayout.test.tsx`'s `installApi` stub).
- **Gotcha:** main tests run under the **Electron ABI** (`scripts/vitest-electron.mjs`) but with **no
  Electron runtime** — inject temp paths; never call `app.getPath`. Renderer tests mock `window.api`.
- **Validate:** `npm run test` green (main + renderer).

---

## Execution Strategy
*How `/harness-implement` should build this. `/harness-implement` reads this verbatim.*
- **Task shape:** A **standard multi-layer feature** with a short parallel leaf group (independent pure/
  service modules) then a hard sequential spine (WorkspaceManager depends on git+allocators+repos → IPC
  depends on it → renderer depends on IPC) and a security-neutral but **filesystem/process-correctness-
  sensitive** core. Medium-High complexity, moderate risk (no auth/PII/payment/migration).
- **Pattern:** **parallelization (leaf group) → prompt-chaining (spine) → evaluator-optimizer (review +
  verify).** Not a single agent (spans main services, IPC, and a real UI); not a full team either (the
  spine is genuinely serial after the leaves).
- **Agents:** parallel leaf group — `coder`(GitService, Task 1) ∥ `coder`(naming+ports+setup, Tasks 2/5);
  then `coder`(WorkspaceManager, Task 3) → `coder`(shared contracts + IPC + main wiring, Tasks 4/6) →
  `frontend-designer`(sidebar/dashboard UI, Task 7) → `test-author`(Task 8) → **`code-review` + `verifier`**
  at the end. Restate in every prompt: `src/shared/**` is **append-only** (README §5.2); status changes go
  **only** through `WorkspaceManager.setStatus`; renderer reaches main **only** via `src/renderer/ipc/`.
- **Orchestration:** `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is enabled in `.claude/settings.json`, so prefer
  the **team** path for the leaf group (Task 1 owner ∥ Tasks 2/5 owner, disjoint files); fall back to
  parallel subagents in one message if `TeamCreate` is unavailable at runtime. The spine (Tasks 3→4/6→7→8)
  is sequential regardless.
- **Parallel decomposition + file-ownership (no two agents touch the same file):**
  - **Leaf group (parallel):** owner A → `src/main/git/**`; owner B → `src/main/workspace/{naming,ports,
    setup}.ts`. Disjoint; both depend only on frozen Phase-0 contracts.
  - **Spine (sequential):** WorkspaceManager owner → `src/main/workspace/index.ts` (after the leaves);
    IPC/wiring owner → `src/shared/ipc.ts` + `src/shared/models.ts` + `src/main/ipc/register.ts` +
    `src/main/index.ts` (after WorkspaceManager); UI owner → `src/renderer/**` (after IPC); tests owner →
    all `*.test.ts(x)` (after its targets exist).
  - **Append-only shared files** (`src/shared/ipc.ts`, `src/shared/models.ts`) are touched by **one** agent
    (the IPC/wiring owner) to avoid concatenation conflicts.
- **Rationale:** the two service leaves are truly independent and gate the manager, so they fan out; the
  manager→IPC→UI chain is a real data dependency, so it chains; and because the create/archive/restore
  filesystem+process cycle is easy to get subtly wrong (dirty worktree removal, port races, event/DB
  ordering), `verifier` is **strongly recommended** even though no heightened-scrutiny path is touched.

---

## Validation Gate
Run after all tasks (from repo root):
```
bash ci/harness-gates.sh typecheck        # fast inner loop: tsc -b (main/preload/renderer/shared)
bash ci/harness-gates.sh format lint      # prettier -c . + eslint .
npm run check                             # full gate: tsc -b && eslint && vitest run && electron-vite build
```
Manual smoke (DoD): `npm run dev` → add a local repo **and** clone a remote (progress streams) → both
register as projects with the correct default branch → create a workspace (a real worktree at
`worktrees/<city>/`, new branch off base, free port, `status=idle`, setup log streamed) → create a 2nd
(unique city, distinct port, no conflict) → archive (worktree gone from disk, DB rows kept, badge
`archived`) → restore (worktree re-created, badge `idle`) → status badges react live to `workspace:status`.

## Acceptance Criteria
- [ ] Add a local repo and clone a remote; both register as projects with the correct default branch.
- [ ] Create a workspace → real worktree at `worktrees/<city>/`, new branch off base, allocated free port,
      `status=idle`, setup script ran and streamed to the panel.
- [ ] Create N workspaces in one project → N isolated worktrees, unique city names, distinct ports, no
      file conflicts.
- [ ] Archive → process-stop hook invoked, `worktree remove` succeeded, worktree gone from disk, DB rows
      retained, status `archived`.
- [ ] Restore → worktree re-created from branch; status back to `idle`; graceful error if a deleted branch
      needs the (absent) Phase-4 checkpoint path.
- [ ] Sidebar lists projects/workspaces with live status badges reacting to `workspace:status`; archived
      rows greyed with restore; New Workspace dialog validates and streams the setup log; PR/issue tabs
      present but disabled.
- [ ] All Validation Gate blocking gates pass (run `/harness-verify`).

## Open Decisions (flagged, not blocking)
- **Clone / create result delivery:** chosen design streams progress **and a terminal result frame**
  (`{phase:'done', project}` / `{kind:'created', workspace}`) over the same scoped stream — reuses the
  Phase-0 `streamProducers` infra with no token correlation and no double work. Alternative (command
  returns the DTO + a separate token-keyed progress stream) is heavier; rejected unless a reviewer objects.
- **No `0002` migration this phase.** PR/issue `sourceKind`/`sourceRef` persist in the existing `0001`
  columns; the Phase-5 `pendingPrompt` prefill does not need storage yet (phase doc §4 makes `0002`
  conditional). Keeping Phase 1 migration-free removes the only heightened-scrutiny (schema) risk. Revisit
  in Phase 5 if the composer prefill must survive a restart.
- **Git driver:** `execa` chosen for imperative CLI + `--progress` stderr parsing; `simple-git` stays the
  documented fallback (both installed). Add a startup `git --version` probe (phase doc §8) — flag if it
  should block app boot or just warn.

---

## Handoff
`/harness-implement plans/phase-1-workspace-engine-plan.md`
</content>
</invoke>
