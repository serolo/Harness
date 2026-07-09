# Implementation Report: Phase 3 — Terminal & Run Scripts

## Plan
`plans/phase-3-terminal-run-plan.md`

## Orchestration
**Mechanism:** parallel-subagents → fell back to **direct implementation in the main session**.

`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, but `TeamCreate` was **not available** to this session, so
the plan's team preference resolved to the parallel-subagent path. I froze the shared contract
(Task 1) myself, then spawned two parallel coders. **Both subagents failed instantly on an
account-wide session-usage limit** (`resets 6:10pm America/Vancouver`), not on anything in the code —
but each had already written its files before the cap hit. I verified their partial output, then
finished the remaining main-side tasks (4–6, 8), wrote all three main tests (the `test-author` agent
had also hit the same cap), and ran the gate — directly, since re-spawning would hit the same limit.

| Agent / role | Task(s) | Outcome |
|---|---|---|
| (main session) | Task 1 — shared IPC contract | DONE |
| main-coder (subagent) | Tasks 2, 3 + partial 4/5/6 | PARTIAL — session-limit failure; `process/{index,env,kill}.ts` landed |
| renderer-coder (subagent) | Task 7 | DONE — all 7 terminal files + AppLayout mount landed |
| (main session) | Tasks 4, 5, 6, 8 + all main tests | DONE (completed the partial main-coder work) |
| code-review + verifier | mandatory review | **NOT RUN** — blocked by the same session limit (see Issues) |

## Tasks Completed
| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Append IPC contract to `src/shared/ipc.ts` | DONE | 6 Commands, 2 StreamChannels, 6 DTOs — append-only; reserved events untouched |
| 2 | `ProcessRegistry` (handle-based) + `kill.ts` | DONE | by main-coder; `Promise.allSettled` best-effort, clear-before-async |
| 3 | `buildEnv` (`process/env.ts`) | DONE | by main-coder; pure; `WorkspaceManager.create` routed through it |
| 4 | `PtyService` (node-pty) | DONE | by main session; async `spawn`, dynamic `import('node-pty')`, registry handle |
| 5 | `ProcessRunner` + `pty:open`/`run:start` producers + 6 command handlers | DONE | runner by main-coder; producers + handlers by main session |
| 6 | Wire construction + teardown (`main/index.ts`, `workspace/index.ts`) | DONE | by main session; before-quit tears down process trees in `finally` |
| 7 | Terminal + Run renderer feature | DONE | by renderer-coder; xterm + run panel + store + AppLayout tab |
| 8 | Docs (`pty/CLAUDE.md`, `ipc/CLAUDE.md`) | DONE | transport decisions 1 & 2 |

## Files Changed
- **Created:** `src/main/process/env.ts`, `src/main/process/kill.ts`, `src/main/process/registry.test.ts`,
  `src/main/process/runner.test.ts`, `src/main/pty/index.test.ts`,
  `src/renderer/features/terminal/{TerminalPanel,TerminalTab,RunPanel}.tsx`,
  `src/renderer/features/terminal/{useTerminal,useRun,terminalStore}.ts`,
  `src/renderer/features/terminal/RunPanel.test.tsx`
- **Modified:** `src/shared/ipc.ts` (append-only), `src/main/process/index.ts` (registry + runner),
  `src/main/pty/index.ts` (PtyService), `src/main/ipc/register.ts` (2 producers + 6 handlers + IDE helper),
  `src/main/index.ts` (construction + before-quit teardown), `src/main/workspace/index.ts` (buildEnv routing),
  `src/renderer/app/AppLayout.tsx` (Chat/Terminal tab switcher), `src/main/pty/CLAUDE.md`, `src/main/ipc/CLAUDE.md`

## Validation Gate Results
| Gate | Result |
|------|--------|
| format | PASS |
| lint | PASS |
| typecheck | PASS (`tsc -b`) |
| tests | PASS — 19 files, 155 tests. New: `registry.test.ts` (6), `runner.test.ts` (3), `pty/index.test.ts` (2), `RunPanel.test.tsx` (4) |
| build | PASS (`electron-vite build`) |

Behaviour-exercising tests: `runner.test.ts` proves live-log tail + exit-code surfaced + `running`/`idle`
overlay + single-vs-concurrent `run_mode`; `pty/index.test.ts` proves a real open→write→echo round-trip,
resize, and close→deregister; `registry.test.ts` proves `treeKillEscalate` kills a real 2-level `sleep`
tree and that `stopWorkspace`/`killAll` are best-effort.

## Acceptance Criteria
- [x] Terminal opens a real shell in the worktree; typing + resize work; `PORT`/env present (`buildEnv`).
- [x] Run-script button appears; start tails logs live; stop terminates the **process tree** (`treeKillEscalate`).
- [x] `run_mode=concurrent` coexists; `single` replaces; `running` overlay reflects state.
- [x] Archive stops the workspace's processes (via `ProcessRegistry.stopWorkspace`) **before** `worktree remove`.
- [x] Big-Terminal toggles; Open-in-IDE launches Cursor/VS Code at the worktree (arg-array `spawn`, no shell).
- [x] App quit (`before-quit`) tree-kills all runs + terminals after agents are interrupted.
- [x] `src/shared/**` changes are append-only; renderer hardening intact; reserved events not removed.
- [x] All Validation Gate blocking gates pass.

## Issues / Deviations
- **Mandatory review not run.** The plan requires `code-review` + `verifier` agents (heightened-scrutiny).
  Both — like the coders — hit the account session limit and cannot be spawned until it resets
  (6:10pm America/Vancouver). **This work has NOT had the required independent review.** Run
  `/harness-review` (or `/code-review high`) once the limit resets before merging.
- **`ide:open` uses `spawn(...,{detached,stdio:'ignore'})`** rather than the plan's literal `execFile` —
  both are arg-array / no-shell (security rule satisfied); `spawn`+`unref` is the correct primitive for
  "launch and detach", resolving on the `spawn` event and rejecting a missing binary as a typed `AppError`.
- **`@xterm/addon-web-links` skipped** — not installed; used only `@xterm/addon-fit` + `@xterm/addon-webgl`
  (WebGL wrapped in try/catch → falls back to the default renderer under jsdom/headless) to avoid an
  unjustified new dependency.
- **PtyService `spawn` is async** (`Promise<string>`) — the stub was sync; changed because the native
  module is dynamically imported (keeps node-pty out of the static type graph). Main-only, not the frozen contract.
- **Overlay clears to `idle`** on last-run exit (not "prior status") — matches the plan's stated
  "(or prior status)" allowance; a `working` agent turn could momentarily be overwritten (known limitation).

## Heightened-scrutiny paths touched
- **Process/PTY execution** (`src/main/pty/*`, `src/main/process/*`): arg-array spawns, no shell-string
  interpolation of workspace-derived input; every child registered + deregistered; `treeKillEscalate`
  SIGTERM→SIGKILL with a hard timeout so teardown can't wedge quit.
- **IPC/preload boundary** (`src/main/ipc/register.ts`): every new handler validates/narrows its payload
  and rejects missing/archived workspaces; producers never throw synchronously (IIFE + `sink.error`);
  no preload signature changes (channels flow through the existing generic funnels).

## Ready for Review
All tasks done; all blocking gates green. **Blocked on the mandatory independent `code-review` +
`verifier` pass**, which could not run due to the account session limit — run it after 6:10pm.
