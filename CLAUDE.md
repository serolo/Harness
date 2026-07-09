# CLAUDE.md — Harness (root working agreement)

An **Electron + Vite + TypeScript desktop app** that manages git workspaces (worktrees), runs an
agent harness, and hosts terminals (node-pty + xterm.js). Built in **phases (0→6)** against a
written spec — the spec (README / `spec §…` references in file headers) is the contract; the code
is scaffolded so later phases build on frozen signatures.

> This file is the repo-wide agreement. Engineering standards live in
> `.claude/rules/{security,architecture,conventions}.md` (tagged `[GATE]`/`[REVIEW]`). Per-subsystem
> notes live in the nearest nested `CLAUDE.md` (e.g. `src/main/ipc`, `src/main/pty`, `src/main/git`).
> The workflow is in `docs/ai_harness/DEVELOPER_WORKFLOW.md` (PIV: `/harness-plan` → `/harness-implement`
> → `/verify` → `/harness-review`).

## Non-negotiables (earned rules — don't break these)

1. **Renderer hardening is non-negotiable.** The renderer reaches main **only** through the frozen
   `window.api` exposed by `src/preload/index.ts` via `contextBridge`. Never expose `ipcRenderer`,
   `require`, `process`, or Node globals to the renderer; `sandbox: true` and `contextIsolation`
   stay on. The preload stays runtime-dependency-free (imports only pure `@shared/*`).
2. **`src/shared/**` is a FROZEN, append-only contract.** The typed IPC maps (`Commands`, `Events`,
   `StreamChannels` in `src/shared/ipc.ts`) *are* the contract — no codegen. **Append** new entries;
   never reorder, rename, or rewrite existing ones. Same for interfaces marked `frozen — DO NOT modify`.
3. **The IPC error boundary is load-bearing.** Every `ipcMain.handle` handler is wrapped so a throw
   is normalized to a typed `AppError` and encoded across the boundary (Electron carries only the
   Error *message* across a `handle()` rejection). Don't throw raw values out of a handler; don't
   bypass the boundary. See `src/main/ipc/register.ts` + `src/preload/index.ts`.
4. **A new main→renderer capability is a typed IPC channel end-to-end:** handler in `src/main/ipc/*`
   → bridge method in `src/preload/*` → client in `src/renderer/ipc/*` → types appended in
   `src/shared/*`. Mirror the nearest existing channel; don't invent a new shape.
5. **DB schema change → a migration** in `scripts/migrate.ts` + a rollback/back-compat note (SQLite
   lives on the user's disk).

## Toolchain house rules

- **npm**, not yarn (`package-lock.json`). Tests are Vitest-under-Electron:
  `node scripts/vitest-electron.mjs run <file>`; files are `*.test.ts(x)`. E2E is Playwright.
- **`execa` is v9 (ESM-only)** — `import { execa }`, never `require()` it, and don't downgrade to
  pin a CommonJS version. Used for `git --progress` stderr streaming.
- **Native modules** (`node-pty`, `better-sqlite3`) need `electron-rebuild` (`npm run rebuild`).
  Keep native bindings **out of the shared type graph** — declare types inline in stubs rather than
  importing the native module where only a type is needed.
- Path aliases: `@shared/*` (both processes), `@renderer/*` (renderer). `src/shared/*` must be
  import-safe from main **and** renderer (no `electron`, Node-only, or DOM-only imports).

## Definition of Done

Gate green (`bash ci/harness-gates.sh`), a `*.test.ts` exercises the new behaviour, behaviour shown
(`/verify`), `src/shared/**` changes are append-only, renderer hardening intact, migrations + a
rollback note for schema changes, and non-obvious new behaviour documented in the nearest
`CLAUDE.md`. Heightened-scrutiny paths (`.claude/rules/security.md`) get a named review.
