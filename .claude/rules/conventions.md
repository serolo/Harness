# Convention Rules

`[GATE]` / `[REVIEW]` tagged, same convention as `security.md`.

## Toolchain (this repo)

- **Package manager:** npm (there is a `package-lock.json`). Not yarn.
- **Language:** TypeScript, strict; project-references build (`tsc -b`).
- **Tests:** Vitest under Electron — `node scripts/vitest-electron.mjs run <file>`. Test files
  are `*.test.ts` / `*.test.tsx` next to the code. E2E is Playwright (`npm run test:e2e`).
- **Lint/format:** `eslint .` and `prettier -c .`.
- **The gate:** `bash ci/harness-gates.sh` (no args → `npm run check` = `tsc -b && eslint . &&
  vitest && electron-vite build`). Subsets: `format`, `lint`, `typecheck`.

## Rules

- `[GATE]` Code passes `tsc -b`, `eslint .`, and the Vitest suite — the `check` gate. No `any`
  to silence the type-checker; no disabling lint rules inline without a reason comment.
- `[REVIEW]` New behaviour ships with a test that exercises it: `*.test.ts(x)` run via
  `node scripts/vitest-electron.mjs`. For a bug fix, write the **failing regression test first**,
  then make it pass (this is the `test-author` agent's job, separate from the `coder`).
- `[REVIEW]` Match the surrounding module's style, naming, and IPC-channel shape rather than
  introducing a new pattern. Mirror the nearest analogue.
- `[REVIEW]` Prefer the repo's existing dedicated modules over new dependencies; justify any new
  npm dep (native modules like better-sqlite3/node-pty need `electron-rebuild`).
