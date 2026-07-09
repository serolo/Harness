# Implementation Report: Phase 0 — Foundation & Scaffolding (Electron)

## Plan
`plans/phase-0-foundation-plan.md`

## Orchestration
**Mechanism:** parallel-subagents (with a sequential spine + convergence)

`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set in `.claude/settings.json`, but the
`TeamCreate` tool was **not available at runtime**, so per the skill's capability check I
fell back to the **parallel-subagent path**: `coder`/`test-author` agents issued from the
main session, with the main session integrating results, adjudicating review findings, and
running gates. The plan's DAG is a hard sequential spine (tooling → frozen contracts) →
a mostly-serial dependency chain (`paths` → `db`/`settings` → `context` → `ipc` → `shell`)
→ convergence → verification, so genuine fan-out was limited to the one safe parallel pair.

| Agent / role | Task(s) | Outcome |
|---|---|---|
| coder (spine) | 1 (tooling/scaffold/install/native-rebuild/CI) + 2 (freeze `src/shared/**` contracts) | DONE |
| coder (main-utils) | 3 (`paths`, `logging`, `error`) | DONE |
| coder (db) ∥ coder (settings) | 4 (`db/**`) ∥ 7 (`settings/**`) — run concurrently | DONE |
| coder (stubs) | 5 (subsystem stubs + `AppContext`) | DONE |
| coder (ipc) | 6 (`ipc/**`, preload, renderer funnel) | DONE |
| coder (app-shell) | 8 (`renderer/**`, IPC-OK indicator) | DONE |
| coder (convergence) | 9 (`src/main/index.ts`, hardened window, wiring) | DONE |
| test-author | 10 (unit + renderer + e2e tests; Electron-ABI test runner) | DONE |
| code-review + verifier | mandatory evaluation | DONE — 1 Critical + 1 AC gap found, both fixed & re-verified |
| main session (integration) | preload-format fix, AppError IPC-boundary fix, regression tests | DONE |

## Tasks Completed
| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Scaffold electron-vite + tooling + native rebuild + CI | DONE | Scripts verbatim per README §8; `@electron/rebuild` green (better-sqlite3 + node-pty, Electron ABI) |
| 2 | Freeze shared contracts (`src/shared/**`) | DONE | Harness §6.3 verbatim (push sink, all 7 `AgentEvent` variants), FROZEN reconciliation comment |
| 3 | Main utils (`paths`/`logging`/`error`) | DONE | Lazy paths + `setUserDataRoot`/`AGENTAPP_USER_DATA` test seam |
| 4 | DB (better-sqlite3 + Kysely + migrations + repos) | DONE | WAL + FK ON, idempotent `user_version` runner, unique(project_id,name) |
| 5 | Subsystem stubs + `AppContext` | DONE | All 11 fields; real signatures, `throw new Error('not implemented')` bodies |
| 6 | IPC framework | DONE | `createStream` + `MessageChannelMain` variant, error boundary, preload exposes only `window.api` |
| 7 | Settings read-only skeleton | DONE | Layered merge (local>shared>user>defaults), absent-file skip, `get()` clone |
| 8 | App shell (renderer) | DONE | 3-pane layout, empty Zustand store, green "IPC OK" indicator |
| 9 | Convergence + hardened window | DONE | contextIsolation/nodeIntegration:false/sandbox/webSecurity + strict CSP (dev/prod), deep-link, before-quit |
| 10 | Tests | DONE | 41 unit + 4 e2e; native-ABI test runner (`ELECTRON_RUN_AS_NODE`) |

## Files Changed
All files are **Created** (greenfield). 49 files under `src/` + `e2e/`, plus root tooling
(`package.json`, `electron.vite.config.ts`, `electron-builder.yml`, `tsconfig.*`,
`vitest.config.ts`, `playwright.config.ts`, eslint/prettier, `.github/workflows/ci.yml`,
`ci/harness-gates.sh`, `scripts/{migrate.ts,vitest-electron.mjs}`, tailwind/postcss).
Key seams: `src/shared/{errors,harness,models,ipc}.ts`, `src/main/context.ts`,
`src/main/index.ts`, `src/main/ipc/*`, `src/preload/index.ts`, `src/renderer/ipc/index.ts`.

## Validation Gate Results
| Gate | Result |
|------|--------|
| format (`prettier -c .`) | PASS |
| lint (`eslint .`) | PASS |
| typecheck (`tsc -b`, all 5 project refs) | PASS |
| tests (unit) | PASS — 41/41 (`vitest` under the Electron ABI). Behaviour tests incl. `e2e/ipc.spec.ts › a thrown AppError arrives in the renderer with its code and details intact` and `… app:echoStream streams chunks in order and completes` |
| build (`electron-vite build`) | PASS — 3 targets (`out/main/index.js`, `out/preload/index.cjs`, `out/renderer/*`) |
| e2e (`playwright test`) | PASS — 4/4 against the built bundle |
| native rebuild (`@electron/rebuild`) | PASS — better-sqlite3 + node-pty for Electron ABI |

**Native-ABI proof:** bare `npx vitest run src/main/db` FAILS with `NODE_MODULE_VERSION 130
… requires 127` (13/13), while `node scripts/vitest-electron.mjs run` (Electron ABI 130)
passes — proving the DB tests genuinely load the native module and are not skipped. No ABI
churn: the test runner and the app run on the same Electron ABI; `check → rebuild → boot`
works with no manual rebuild in between.

## Acceptance Criteria (Phase 0 DoD)
- [x] `npm run dev`/built app launches; window shows the 3-pane shell + green "IPC OK" from `app:ping` (proven live via `e2e/boot.spec.ts`).
- [x] `npm run check` fully green (`tsc -b`, eslint, vitest, `electron-vite build`).
- [x] Renderer hardened: no Node globals / `ipcRenderer` reachable (e2e asserts `ipcRenderer/require/process` undefined); only `window.api`; contextIsolation + nodeIntegration:false + sandbox + strict prod CSP.
- [x] Fresh-DB migration creates `projects` + `workspaces` (+ indexes); round-trip insert+read of a `Project` and `Workspace`; unique + FK enforced.
- [x] `AppContext` exposes a stub for every subsystem in README §3 (all 11 fields); type-checks.
- [x] `Harness` + `AgentEvent` verbatim per README §6.3 (push sink; reconciliation noted) in `src/shared/harness.ts`.
- [x] `paths`, `AppError`, `SettingsService.get()`, `electron-log` to `logs/` all functional.
- [x] `app:echoStream` demonstrates `createStream()` **end-to-end** (e2e drives it: ordered chunks + completion).
- [x] `@electron/rebuild` builds better-sqlite3 + node-pty for the Electron ABI locally **and** in CI (`.github/workflows/ci.yml`).

## Issues / Deviations

### Found by review/verify and FIXED (with regression tests)
1. **Sandboxed preload emitted as ESM (build-only, packaged app broke).** With
   `"type":"module"`, `electron-vite build` produced `out/preload/index.mjs` (ESM), but a
   `sandbox:true` preload must be CommonJS → `window.api` never exposed in the built app.
   **Fix:** preload build now outputs `format:'cjs'` + `index.cjs`; `index.ts` preload path
   updated. Verified by `e2e/boot.spec.ts` (green IPC OK in the built bundle).
2. **`AppError` lost `code`/`details` across the command IPC boundary (Critical).**
   Empirically confirmed (throwaway Electron repro): `ipcMain.handle` rejections carry only
   the message string, AND the `contextBridge` preload→renderer hop strips custom props off
   `Error` instances (a plain object clones intact). Original code threw `toJSON()` and
   revived in the preload → every command error collapsed to `code:'internal'`.
   **Fix (two boundaries):** main encodes the `SerializedAppError` into the thrown Error
   message (`encodeAppErrorMessage`); the preload decodes it and rejects with the **plain**
   `SerializedAppError`; the **renderer funnel** (`src/renderer/ipc/index.ts`) revives it to
   a typed `AppError` (matches README §7.2/§10). Stream errors already clone intact via
   `webContents.send` and are unchanged. Verified by `e2e/ipc.spec.ts` (real cross-process
   assertion of `code`/`details`) + 3 codec unit tests.
3. **Misleading structured-clone comments in `src/shared/errors.ts`.** Corrected to
   describe the actual two-boundary transport (comment-only; contract shape unchanged).

### Known follow-ups (non-blocking, deferred by design)
- **`MessageChannelMain` stream variant is implemented but unwired** (no renderer port
  consumer yet). It was plan-mandated in Task 6; its real consumer (PTY bytes / agent
  tokens) lands in **Phase 2/3**, which will wire + leak-test it. `app:echoStream` proves
  the scoped-channel `createStream()` path end-to-end today.
- **`stream:start` does not validate `arg` against the channel contract** before invoking
  the producer (it degrades safely to `sink.error`). A per-channel zod validator is a
  reasonable hardening when real producers land (Phase 2/3) / with the settings validation
  work (Phase 6).
- **DB handle is not closed on `before-quit`** (benign at this scale with WAL; OS reclaims).
  A `ctx.db.destroy()` in the existing `before-quit` scaffold is a small follow-up.

## Heightened-scrutiny paths touched
- **Renderer security hardening** (contextIsolation/sandbox/CSP, preload surface) — verified
  live (no Node/`ipcRenderer` leak; strict prod CSP).
- **Native-module ABI** (better-sqlite3, node-pty) — rebuilt for Electron ABI; test runner
  aligned to the same ABI with proof.
- No auth/SSO, secrets, payment/FOP, PII, GDS, i18n touched. Migrations: only `0001_core`
  (core tables), idempotent, tested. Branding/appId (`com.serolo.harness`, `harness://`)
  is set but flagged **provisional** (Open Decision, README §11).

## Ready for Review
All 10 plan tasks done; the mandatory code-review + verifier ran, their one Critical + one
AC gap were fixed and independently re-verified with real end-to-end tests; all blocking
gates (format, lint, typecheck, unit tests, build, e2e, native rebuild) are green.

**Handoff:** run `/verify` (evidence write-up), then `/harness-review` (or comment
`/claude-review` on the PR).
