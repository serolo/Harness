# Phase 1 — Workspace Engine (Electron)

> **Read [`README.md`](./README.md) then [`phase-0-foundation.md`](./phase-0-foundation.md) first.**

**Spec refs:** §2.3 (filesystem), §3 (projects/workspaces), §5.1 (workspace engine), §8 (M1).
**Estimated size:** ~2 weeks. **Depends on:** Phase 0. **Blocks:** Phases 2, 3, 4, 5.
**Parallelizable with:** Phase 2 (against stubs).

---

## 1. Goal

Register/clone git projects, and create/archive/restore isolated **workspaces** (git worktree + branch
+ metadata + allocated port), driven by a real `GitService` and `WorkspaceManager` in the main process.
Ship the sidebar/dashboard that lists projects and workspaces with live status. This is the app's
backbone: the unit every later subsystem attaches to.

---

## 2. Scope

**In scope**
- `GitService` (drives the system `git` binary via `execa`/`simple-git`): clone, fetch, worktree
  add/list/remove, branch create/checkout, resolve default branch, merge-base, HEAD info.
- Project registration: add existing local repo **or** clone from URL into `projects/<id>/repo/`.
- `WorkspaceManager`: create / archive / restore, status machine ownership, port allocation, name
  allocation (city list), setup-script execution streamed to a log.
- Create workspace from: **branch** (new branch off base) and **existing branch** (checkout).
  *Create-from-PR/GitHub-issue/Linear-issue prefill is stubbed here and completed in Phase 5.*
- Sidebar/dashboard UI: project switcher, workspace list grouped by project, status badges, create
  dialog, archive/restore, setup-log panel.

**Out of scope**
- Chat/turns (Phase 2), terminal/run (Phase 3), diff/checkpoints (Phase 4), PR/issue sources (Phase 5).

---

## 3. Task breakdown

### 3.1 GitService (`src/main/git/`)
Thin typed wrapper over the `git` CLI (async via `execa`). Prefer the CLI for worktrees/refs/diff —
most reliable in Node (README §2). Public API:
```ts
class GitService {
  clone(url: string, dest: string, onProgress: StreamSink<CloneProgress>): Promise<void>;
  open(repoPath: string): Promise<RepoInfo>;
  fetch(repoPath: string, remote?: string): Promise<void>;
  defaultBranch(repoPath: string): Promise<string>;                 // origin/HEAD symref
  worktreeAdd(repo: string, wtPath: string, branch: string, base: string, createBranch: boolean): Promise<void>;
  worktreeRemove(repo: string, wtPath: string, force: boolean): Promise<void>;
  worktreeList(repo: string): Promise<WorktreeInfo[]>;
  branchExists(repo: string, name: string): Promise<boolean>;
  headInfo(wt: string): Promise<HeadInfo>;                          // sha, branch, ahead/behind
  mergeBase(wt: string, a: string, b: string): Promise<string>;
}
```
- `worktreeAdd` → `git -C <repo> worktree add <path> -b <branch> <base>` (spec §5.1 step 2).
- Clone/fetch: parse `git clone --progress` stderr → stream `CloneProgress` to the create dialog.
- Auth for clone/fetch/push: rely on the user's git credential helper / SSH agent (no token handling
  here; Phase 5 adds GitHub token-based remotes if needed).
- Wrap `execa` errors → `AppError{ code:'git' }` with stderr in `details`.

### 3.2 Name & port allocation (`src/main/workspace/naming.ts`, `ports.ts`)
- `naming`: embedded city list; `allocate(projectId)` → first city not used by a live (non-archived)
  workspace in that project; fallback to `city-2` suffixing when exhausted.
- `ports`: `allocate()` probe-and-retry a free TCP port in a configurable range (spec §9 port risk)
  using `net.createServer().listen(0)` or explicit range probing; record on workspace; overridable
  per workspace.

### 3.3 WorkspaceManager (`src/main/workspace/`)
```ts
class WorkspaceManager {
  create(req: CreateWorkspaceReq, log: StreamSink<SetupLog>): Promise<Workspace>;
  archive(id: string): Promise<void>;
  restore(id: string): Promise<Workspace>;
  setStatus(id: string, status: WorkspaceStatus): Promise<void>;   // sole status writer → emits event
  list(projectId: string): Promise<Workspace[]>;
  get(id: string): Promise<Workspace>;
}
```
- **create** (spec §5.1): allocate name+branch → `fetch` → `worktreeAdd` → persist row (status `idle`)
  → run `setup` script streaming to `log` → allocate port → emit `workspace:created`.
  `sourceKind`/`sourceRef` from `req` (branch now; pr/issue accepted but prefill handled in Phase 5 —
  store the ref, stash a `pendingPrompt` for Phase 5's composer prefill).
- **archive** (spec §5.1): run optional `archive` script → **stop the workspace's process tree**
  (delegate to `ProcessRegistry.stopWorkspace()` — Phase 3 owns it; Phase 1 defines a no-op hook that
  Phase 3 fills) → `worktreeRemove` → set `worktreePath = null`, `status = archived`, `archivedAt`.
  **Keep** all DB rows (turns/events/comments/todos) for restore.
- **restore**: re-add worktree from the branch; if the branch was deleted, recreate from the last
  checkpoint ref (CheckpointService, Phase 4 — guard with a graceful error if absent). Chat reattaches
  because rows are intact.
- **setStatus**: the *only* writer of `status`; emits `workspace:status`. Enforces the machine in
  README §6.4 (`running` overlay tracked separately from the base state).

### 3.4 Setup-script execution
- Small command runner (seed of Phase 3's `ProcessRunner`): `execa`/`spawn` the `setup` command from
  settings with `cwd = worktree`, env incl. `PORT`/`APP_PORT`, stream stdout/stderr to the `SetupLog`
  sink, capture exit code. Non-zero → surface as `needs_attention` with the log tail. **Coordinate
  with Phase 3** so this runner is shared, not duplicated.

### 3.5 Sidebar / dashboard UI (`src/renderer/features/sidebar/`)
- Project switcher (add project: pick local dir via `dialog.showOpenDialog` from main, or enter clone
  URL → clone with streamed progress).
- Workspace list per project: name (city), branch, status badge (idle/working/needs_attention/running/
  archived), harness icon, port. Live-updates via `workspace:status`/`created`/`archived`.
- **New Workspace dialog** (⌘⇧N wired in Phase 6): base branch, harness, optional custom branch name,
  source = branch (PR/issue tabs present but disabled/"coming in integration" until Phase 5). Shows
  streaming setup log.
- Archive/restore with confirm; archived workspaces collapsed/greyed.
- Zustand `workspaceStore` + TanStack Query for list fetches; subscribe to events for live updates.

---

## 4. Data model owned by this phase
- Uses `projects`, `workspaces` from Phase 0's `0001_core`. If `pendingPrompt` needs persistence for
  the PR/issue handoff, add migration `0002_workspace_pending_prompt` (nullable TEXT). Otherwise no new
  tables.

## 5. IPC surface added
- Commands: `project:add(localPath)`, `project:clone(url)` (streamed), `project:list`,
  `workspace:create(req)` (streamed setup log), `workspace:list(projectId)`, `workspace:get(id)`,
  `workspace:archive(id)`, `workspace:restore(id)`, `workspace:setStatus(id, status)` (internal).
- Streams: `CloneProgress`, `SetupLog`.
- Events: `workspace:created`, `workspace:archived`, `workspace:status` (now emitted for real).

## 6. Definition of Done
- [ ] Add a local repo and clone a remote repo; both register as projects with correct default branch.
- [ ] Create a workspace → a real git worktree exists at `worktrees/<city>/`, on a new branch off base,
      with an allocated free port, `status=idle`, setup script ran and streamed to the panel.
- [ ] Create N workspaces in one project → N isolated worktrees, unique city names, no file conflicts,
      distinct ports.
- [ ] Archive → process tree stopped (hook), `worktree remove` succeeded, worktree gone from disk, DB
      rows retained, status `archived`.
- [ ] Restore → worktree re-created from branch; status back to `idle`.
- [ ] Sidebar lists projects/workspaces with live status badges reacting to `workspace:status`.
- [ ] `npm run check` green.

## 7. Tests
- Integration (temp repos in tmpdir, real `git`): clone/open, default-branch resolution, worktree
  add/list/remove, merge-base, ahead/behind. Create→archive→restore full cycle asserts filesystem + DB.
- Naming allocator (uniqueness, exhaustion) and port allocator (probe-retry) unit tests.
- Renderer: sidebar renders seeded projects/workspaces; create dialog validates; status event updates badge.

## 8. Risks / notes
- **Worktree remove with a dirty/locked worktree** → force + the process-stop hook first (spec §9).
  Never `worktree remove` while the agent/run process holds files.
- **Branch already exists** on create → detect and either check out or error clearly (don't clobber).
- **Restore when branch deleted** depends on Phase 4 checkpoints — degrade gracefully with a clear
  message if Phase 4 isn't present yet (`// INTEGRATION(phase-4)`).
- Setup runner must become the shared `ProcessRunner` in Phase 3 — mark the seam.
- **git not on PATH / old git** → detect in a startup check; surface a clear onboarding error.
