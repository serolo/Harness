# Plan: Phase 8 — Harness Conformance Test Bench

## Ticket / Feature
`docs/implementation-plan/phase-8-harness-conformance-bench.md` — an executable conformance bench
(Layer 1 offline fixture-replay in the default gate; Layer 2 env-gated live probes, nightly) that
catches a harness adapter's declared `HarnessCapabilities`/behavior silently drifting from
reality, plus an optional diagnostics IPC command. **Observes and asserts only** — no adapter
runtime logic changes.

## Findings from codebase reconciliation (do not skip — these change the ticket's sketch)

1. **The ticket's §3.2 illustrative `BENCH_PROFILES` values are wrong** for two adapters (the
   ticket itself instructs reconciliation). Real values:
   - `claude_code` (`src/main/harness/claude-code.ts:52-59`): all four flags `true` — ticket
     sketch says `rawTerminalFallback: false`.
   - `codex` (`src/main/harness/codex.ts:68-79`): `supportsResume: true, supportsMcp: true,
     supportsPlanMode: false, rawTerminalFallback: true` — ticket sketch says all `false`.
   - `cursor` (`src/main/harness/cursor.ts:74-85`): matches the sketch.
   Per the ticket, record this as a Phase-8 finding in a code comment on `BENCH_PROFILES`.
2. **No existing fixture contains an MCP-shaped `tool_use`** (`grep -l mcp fixtures/**` is
   empty), so `capability:supportsMcp` (`true` for claude_code and codex) has no corroborating
   evidence today. Fix by **adding new fixture files** (allowed — fixtures are hand-authored
   test data, not adapter logic): `fixtures/mcp_tool_use.jsonl` and
   `fixtures/codex/mcp_tool_use.jsonl`, each with a `tool_use` whose name starts `mcp__`.
3. **`MockHarness.id` is `'claude_code'`** (`src/main/harness/mock.ts:71`, Open Decision D2), so
   it cannot be a fourth key in `Record<HarnessId, BenchProfile>`. Export a separate
   `MOCK_BENCH_PROFILE` const used only by tests.
4. **The preload/renderer IPC plumbing is generic** (`invoke<C extends CommandChannel>` in
   `src/preload/index.ts:79` and `src/renderer/ipc/index.ts:49`): the new command needs only the
   `Commands` append in `src/shared/ipc.ts` + a handler in `src/main/ipc/register.ts`. No
   preload/renderer file changes.
5. **`runLayer1` must be `async`** (`Promise<BenchReport>`, deviating from the ticket's sync
   sketch): the `raw_terminal` transport must replay through the real
   `RawTerminalTranscript` (`src/main/harness/raw-terminal.ts:135`), which is timer-driven
   (idle-boundary `setTimeout`). A sync signature would force a bench-only reimplementation of
   the chunking path — exactly what the ticket forbids ("never a bench-specific
   reimplementation of parsing"). Use a fake spawner + tiny `idleTimeoutMs` so it stays fast.
6. Two capability flags are **not observable from recorded fixtures**: `supportsPlanMode` and
   `rawTerminalFallback` are spawn-time/argv affordances, not stream shapes. Their Layer-1
   probes report `skip` with an explanatory detail (never a fabricated `pass` — no false
   confidence; not `drift` — there is no possible fixture evidence channel). Evidence mapping:
   - `capability:supportsResume` (`true`) → a session-capture observed during replay
     (`resume.jsonl` fixtures already provide this for claude_code + codex).
   - `capability:supportsMcp` (`true`) → a `tool_use` event with `name.startsWith('mcp__')`
     (new fixtures from finding 2).
   - `capability:supportsPlanMode` / `capability:rawTerminalFallback` (`true`) → `skip` + detail.
   - Any flag declared `false` → trivially `pass` (per ticket: absence isn't drift).
7. **Layer 1 lands in the gate automatically**: `ci/harness-gates.sh` `tests` gate runs
   `node scripts/vitest-electron.mjs run` (all `*.test.ts`), so `bench/runner.test.ts` is picked
   up with zero gate-script changes — exactly what the ticket's scope requires.

## Affected Files

### Read before implementing
- `src/shared/harness.ts` (lines 12–46, 68–80) — `HarnessId`, `AgentEvent['kind']`,
  `HarnessCapabilities`; the frozen contract `BenchProfile` types reference.
- `src/main/harness/parser.ts` (lines 52–93, 152–170) — `createJsonLineSplitter` + `normalize`,
  the real claude_code replay path.
- `src/main/harness/codex.ts` (lines 248–269) — exported `normalizeCodex`, the real codex replay
  path; header documents the ASSUMED-format risk Layer 2 must surface (DoD §6 bullet 5).
- `src/main/harness/raw-terminal.ts` (lines 55–97, 135–247) — `RawPtySpawner`/`RawPtyHandle`
  seam + `RawTerminalTranscript`, the real cursor replay path.
- `src/main/harness/raw-terminal.test.ts` + `cursor.test.ts` — the existing **fake-spawner
  pattern** to mirror for raw-terminal replay.
- `src/main/harness/codex.test.ts` (lines 12–30) — the fixture-loading pattern
  (`readFileSync(fileURLToPath(new URL('./fixtures/…', import.meta.url)))`) to mirror.
- `src/main/harness/mock.ts` (lines 41–95) — default script + capabilities for
  `MOCK_BENCH_PROFILE`.
- `src/main/harness/supervisor.ts` (lines 66–105) — adapter registry; how `detect()` degrades
  when a CLI is absent (Layer 2 `skip` semantics mirror this).
- `src/main/ipc/register.ts` (lines 770–790) — the `handle('harness:…')` validate-and-narrow
  pattern to mirror; also `src/main/ipc/CLAUDE.md`.
- `src/shared/ipc.ts` (lines 114–160, 456–461) — `Commands` map append point + `HarnessInfo`
  precedent for a harness-keyed DTO.
- `src/main/context.ts` (line 40) + `src/main/index.ts` (lines 420–435) — `AppContext` shape and
  service wiring (where the bench-report store is created/registered); the existing
  `RawPtySpawner` adapter (`pty.spawnRaw`) Layer 2 reuses for cursor.
- `.github/workflows/ci.yml` — workflow conventions (macos runner, node 22, npm ci,
  electron-rebuild) to mirror in the nightly workflow.

### Modify (all appends — no rewrites)
- `src/shared/ipc.ts` — append `'harness:benchReport'` to `Commands` (Phase 8 section comment).
- `src/main/ipc/register.ts` — append the `harness:benchReport` handler.
- `src/main/context.ts` — append a `benchReports: BenchReportStore` member to `AppContext`.
- `src/main/index.ts` — construct the store and pass it into the context (one-line wiring).
- `src/main/harness/CLAUDE.md` (if present; else nearest) — document the bench subsystem +
  the profile-reconciliation findings (per repo Definition of Done).

### Create
- `src/shared/bench.ts` — `BenchVerdict`, `BenchProbeResult`, `BenchProfile`, `BenchReport`
  (ticket §3.1 shapes verbatim; type-only imports from `./harness`; import-safe both processes).
- `src/main/harness/bench/profiles.ts` — `BENCH_PROFILES: Record<HarnessId, BenchProfile>`
  (reconciled values from finding 1, with the finding recorded in a comment) +
  `MOCK_BENCH_PROFILE` (finding 3).
- `src/main/harness/bench/runner.ts` — `FixtureSet`, `runLayer1(profile, fixtures):
  Promise<BenchReport>` (finding 5) + a small `BenchReportStore` (in-memory
  `Map<HarnessId, BenchReport>`, `set`/`get`) the IPC handler reads.
- `src/main/harness/bench/runner.test.ts` — pass cases + fail-closed regression (see Task 5).
- `src/main/harness/bench/live-probes.ts` — `runBasicTurn` / `runPolicyTurn` / `runInterrupt`.
- `src/main/harness/bench/live-probes.test.ts` — env-gated live suite.
- `src/main/harness/fixtures/mcp_tool_use.jsonl` — claude_code MCP evidence (finding 2).
- `src/main/harness/fixtures/codex/mcp_tool_use.jsonl` — codex MCP evidence (finding 2).
- `.github/workflows/harness-bench-nightly.yml` — nightly + manual-dispatch Layer 2 workflow.

## Ordered Tasks

### Task 1 — Create `src/shared/bench.ts` (shared types)
- What: the four ticket §3.1 types, verbatim shapes, `import type { AgentEvent,
  HarnessCapabilities, HarnessId } from './harness'`. Header comment marks the file
  append-only per the `src/shared/**` freeze.
- Pattern: `src/shared/harness.ts:1-12` — header style; type-only imports keep it import-safe
  from both processes (architecture rule).
- Gotcha: no `electron`/Node/DOM imports; `src/shared/**` is FROZEN/append-only from day one.
- Validate: `bash ci/harness-gates.sh typecheck`

### Task 2 — Create `src/main/harness/bench/profiles.ts`
- What: `BENCH_PROFILES` with the **reconciled** capability values (finding 1) and
  `expectedEventKinds` matched to what each harness's fixtures actually produce:
  - `claude_code` (json_stream): `['text','tool_use','tool_result','file_edit','todo_update','turn_end','error']`
    — verify `todo_update` appears in an existing fixture; if not, extend a fixture, don't trim
    the profile (the profile documents the adapter's real emit surface, per `parser.ts`'s table).
  - `codex` (json_stream): `['text','tool_use','file_edit','turn_end','error']` — note
    `normalizeCodex` never emits `tool_result` or `todo_update` (codex.ts normalization table),
    so the ticket sketch's `tool_result` must be dropped after verifying against fixtures.
  - `cursor` (raw_terminal): `['text','turn_end','error']` (error requires a nonzero-exit replay
    case — see Task 4).
  Plus `MOCK_BENCH_PROFILE` (all caps `true` per `mock.ts:84-91`; kinds
  `['text','todo_update','turn_end']` from the default script).
- Pattern: `src/main/harness/codex.ts:68-79` — capability comment style; a top-of-const comment
  records the ticket-vs-reality reconciliation finding.
- Gotcha: do NOT copy the ticket's illustrative values; every field is read off the adapter
  source at implementation time.
- Validate: `bash ci/harness-gates.sh typecheck`

### Task 3 — Add MCP-evidence fixtures
- What: `fixtures/mcp_tool_use.jsonl` — a claude_code stream (`system/init` →
  `assistant` message with a `tool_use` block named e.g. `mcp__github__get_pr` → matching
  `user`/`tool_result` → `result/success`). `fixtures/codex/mcp_tool_use.jsonl` — assumed-codex
  shape (`session_configured` → `tool_call` named `mcp__…` → `turn_complete`).
- Pattern: `fixtures/tool_use.jsonl` (claude_code) and `fixtures/codex/tool_use.jsonl` — copy a
  line and change the tool name; keep session ids fixture-unique.
- Gotcha: fixtures are data, not code — adding files never touches the frozen adapters. Codex
  fixture must follow the ASSUMED format documented in `codex.ts`'s header exactly.
- Validate: `node scripts/vitest-electron.mjs run src/main/harness/codex.test.ts src/main/harness/parser.test.ts` (existing suites still green)

### Task 4 — Create `src/main/harness/bench/runner.ts` (Layer 1)
- What: `runLayer1(profile: BenchProfile, fixtures: FixtureSet): Promise<BenchReport>` +
  `BenchReportStore`.
  - `json_stream` replay: per file, feed contents through a fresh
    `createJsonLineSplitter()` (`parser.ts:52`) then `normalize` (`parser.ts:152`) for
    `claude_code`, or `normalizeCodex` (`codex.ts:248`) for `codex`; collect emitted
    `AgentEvent['kind']`s and whether a session capture occurred. Dispatch on
    `profile.harnessId` — never re-implement parsing.
  - `raw_terminal` replay: construct a `RawTerminalTranscript` (`raw-terminal.ts:135`) with a
    fake `RawPtySpawner` that replays the fixture file as `onData` chunks then fires `onExit`
    (exit 0 for `transcript.txt`/`ansi.txt`; one synthetic nonzero-exit replay to evidence the
    `error` kind), `idleTimeoutMs` ~10ms; collect events off a capturing `StreamSink`.
  - Verdicts (each its own `BenchProbeResult`): `expectedEventKinds` (every declared kind seen
    across the fixture union, else `drift` naming the missing kinds in `detail`);
    `capability:<flag>` per finding 6's evidence table; empty `fixtures.files` → single `skip`
    result with detail (never `pass`).
  - `detail` strings carry kind/flag names and counts only — **never fixture content** (mirrors
    the "length only" logging convention).
- Pattern: fake-spawner shape in `src/main/harness/raw-terminal.test.ts`; fixture reading in
  `codex.test.ts:26-28`.
- Gotcha: heightened-scrutiny adjacency — the runner reads files given to it; it must only ever
  be handed paths under `src/main/harness/fixtures/**` by its callers (tests), and it spawns
  nothing. Keep `better-sqlite3`/`node-pty` out of its imports (native-free module, like
  `raw-terminal.ts`).
- Validate: `bash ci/harness-gates.sh typecheck lint`

### Task 5 — Create `src/main/harness/bench/runner.test.ts`
- What:
  1. Pass case per registered harness: glob that harness's real fixture files
     (claude_code → `fixtures/*.jsonl`, codex → `fixtures/codex/*.jsonl`, cursor →
     `fixtures/cursor/*.txt`), run `runLayer1` with its `BENCH_PROFILES` entry, assert **no
     `drift`** in any result (skips allowed per finding 6).
  2. MockHarness coverage: run `MockHarness` with a capturing sink (it's deterministic and
     in-process — no fixtures needed), collect kinds, assert they cover
     `MOCK_BENCH_PROFILE.expectedEventKinds`.
  3. **Fail-closed regression (DoD bullet 3)**: a deliberately mismatched profile — e.g. the
     cursor profile plus a claimed `'todo_update'` kind that provably never appears in
     raw-terminal output — must yield verdict `drift` for `expectedEventKinds`, and explicitly
     `expect(...).not.toBe('skip')` / not silent-pass.
  4. No-fixtures case: `runLayer1(profile, { files: [] })` → `skip` with a detail string.
- Pattern: `codex.test.ts` describe/fixture structure; `mock.test.ts` for the capturing-sink
  shape.
- Gotcha: this suite runs inside the default gate — keep it offline (no spawn, no network) and
  fast (small `idleTimeoutMs` for the raw replay).
- Validate: `node scripts/vitest-electron.mjs run src/main/harness/bench/runner.test.ts`

### Task 6 — Create `src/main/harness/bench/live-probes.ts` (Layer 2)
- What: three exported probes taking a `Harness`:
  - `runBasicTurn` — `fs.mkdtemp` scratch dir + `git init` (via `execa` arg-array, never shell),
    `harness.startTurn` with a trivial prompt and a capturing sink, assert a terminal
    (`turn_end`/`error`) event within a bounded timeout (~120s), always interrupt + rm the
    scratch dir in `finally`.
  - `runPolicyTurn` — same scratch-repo setup with `permissionPolicy: { deny: ['*'],
    allowedTools: [] }`; verdict `drift` if any `tool_result`/`file_edit` event indicates a tool
    actually executed.
  - `runInterrupt` — start a turn, call `handle.interrupt()` immediately, assert a terminal
    event fires AND no orphan remains: poll `pgrep -f <scratch-dir>` (the mkdtemp path is
    unique, so a surviving process whose argv/cwd references it is an orphan) until empty or
    timeout → `drift`.
  - Every probe body in try/catch → thrown error maps to `{ verdict: 'drift', detail:
    err.message }`; **never** raw CLI stdout/stderr or env values in `detail`.
- Pattern: scratch-repo hygiene mirrors `codex.ts`'s `mkdtempSync` usage (codex.ts:397);
  arg-array spawning per `.claude/rules/security.md`.
- Gotcha: **scratch-repo isolation is load-bearing** (ticket §8) — the cwd must come only from
  `mkdtemp`, never from any project/workspace path. This file touches process execution
  (heightened-scrutiny): named security note required in review.
- Validate: `bash ci/harness-gates.sh typecheck lint`

### Task 7 — Create `src/main/harness/bench/live-probes.test.ts`
- What: `describe.skipIf(process.env.AGENTAPP_BENCH_LIVE !== '1')` wrapping everything. For each
  of `ClaudeCodeHarness` / `CodexHarness` / `CursorHarness` (cursor gets a real
  `RawPtySpawner` adapter over `PtyService.spawnRaw`, mirroring `src/main/index.ts:421-423`):
  call `detect()` first — `installed: false` → record a `skip` `BenchProbeResult` (a missing CLI
  must not fail the run, ticket §7); else run the three probes. Aggregate into a `BenchReport`,
  write it to a JSON file under a path from `process.env.BENCH_REPORT_DIR` (for the CI artifact)
  and into the `BenchReportStore`. The suite asserts probes **complete with a verdict** — it
  does not assert `pass` (an expected codex `drift`/`skip` is a finding, not a failure; DoD
  bullet 5).
- Pattern: env-gate convention already used for `AGENTAPP_MOCK_HARNESS`/`AGENTAPP_E2E`
  (`src/main/index.ts`, `src/main/ipc/register.ts`).
- Gotcha: when `AGENTAPP_BENCH_LIVE` is unset this file must contribute zero work to the default
  gate (skipIf at the top-level describe; no module-level side effects that spawn anything).
- Validate: `node scripts/vitest-electron.mjs run src/main/harness/bench/live-probes.test.ts`
  (should report skipped locally), then once more with `AGENTAPP_BENCH_LIVE=1` if a CLI is
  installed locally.

### Task 8 — Diagnostics IPC channel `harness:benchReport`
- What: append to `Commands` in `src/shared/ipc.ts` under a `--- Phase 8 (APPEND-ONLY) ---`
  section: `'harness:benchReport': { req: { harnessId: HarnessId }; res: BenchReport | null }`
  (type-only import from `./bench`). Add `benchReports: BenchReportStore` to `AppContext`
  (`src/main/context.ts`), construct it in `src/main/index.ts`, and append a handler in
  `src/main/ipc/register.ts` that narrows `req.harnessId` against the three known ids (throw
  `AppError('invalid_input', …)` otherwise — mirror the `harness:detect`/`chat:history`
  validation style at register.ts:772-788) and returns `ctx.benchReports.get(id) ?? null`.
- Pattern: `src/main/ipc/register.ts:784-788`; `HarnessInfo` DTO precedent in
  `src/shared/ipc.ts:456-461`. No preload/renderer changes (finding 4).
- Gotcha: IPC boundary = heightened-scrutiny path → validate/narrow the untrusted payload;
  `src/shared/ipc.ts` change must be a pure append (no reorder/rename). Read-only handler — no
  side effects.
- Validate: `bash ci/harness-gates.sh typecheck lint` +
  `node scripts/vitest-electron.mjs run src/main/ipc` (existing IPC suites stay green)

### Task 9 — `.github/workflows/harness-bench-nightly.yml`
- What: `on: { schedule: [cron nightly], workflow_dispatch: {} }`; single job mirroring
  `ci.yml`'s setup (macos-latest, node 22, `npm ci`, `npx @electron/rebuild -f -w
  better-sqlite3,node-pty`); step env `AGENTAPP_BENCH_LIVE: '1'`, `BENCH_REPORT_DIR:
  ${{ runner.temp }}/bench-reports`; run `node scripts/vitest-electron.mjs run
  src/main/harness/bench/live-probes.test.ts`; `actions/upload-artifact@v4` on the report dir
  (JSON only), `if: always()`. **No `ci/harness-gates.sh` changes.**
- Pattern: `.github/workflows/ci.yml`.
- Gotcha: no secrets/credentials are assumed or configured; absent CLIs on the runner produce
  `skip` reports, and the job still succeeds + uploads them. Prettier checks YAML — run
  `npx prettier -w` on the new file.
- Validate: `bash ci/harness-gates.sh format` ; the "dispatched at least once" DoD item can only
  be satisfied **after the branch is pushed** (workflow_dispatch needs the workflow on a pushed
  ref) — flag it in the PR description as a post-push checklist item.

### Task 10 — Document in nearest CLAUDE.md
- What: add a short "bench" section to the harness subsystem's `CLAUDE.md` (create
  `src/main/harness/CLAUDE.md` if none exists): what Layer 1 proves (fixtures↔profile
  consistency only — NOT live-CLI conformance, ticket §8 false-confidence risk), the
  `AGENTAPP_BENCH_LIVE` gate, the capability-evidence table (finding 6), and the
  profile-reconciliation findings.
- Validate: `bash ci/harness-gates.sh format`

## Execution Strategy
*How `/harness-implement` should build this. `/harness-implement` reads this verbatim.*
- **Task shape:** standard feature, one bounded topology (a new `bench/` module + appends), but
  it touches two heightened-scrutiny paths: the IPC boundary append (Task 8) and process
  execution in Layer 2 probes (Task 6).
- **Pattern:** prompt-chaining + evaluator-optimizer, with the mandatory-verifier escalation for
  the heightened-scrutiny tasks.
- **Agents:** `coder` (Tasks 1–4, 6, 8–10) → `test-author` (Tasks 5 + 7, independently deciding
  what "tested" means — the fail-closed regression in Task 5 is the phase's core invariant) →
  `code-review` + `verifier` in parallel (verifier mandatory; review must include a **named
  security note** on Task 6's process execution/scratch-repo isolation and Task 8's IPC input
  narrowing, per `.claude/rules/security.md`).
- **Orchestration:** prefer team if `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` enabled, else
  parallel subagents (coder and test-author can overlap once Tasks 1–2 land, since profiles.ts
  + runner.ts signatures are the interface the tests consume).
- **Parallel decomposition + file-ownership:** coder owns everything except
  `bench/runner.test.ts` and `bench/live-probes.test.ts`, which test-author owns exclusively —
  no shared files. Tasks 1→2→(3,4)→8 are sequential for the coder (type deps); Task 9–10 are
  independent and can be done any time after Task 7's env-var name is fixed.
- **Rationale:** one cohesive new module doesn't justify multi-coder sectioning; the
  heightened-scrutiny touchpoints make the verifier + named security review non-optional.

## Validation Gate
Run after all tasks (from repo root):
```
bash ci/harness-gates.sh format lint typecheck   # fast inner loop
bash ci/harness-gates.sh                          # full gate before PR (npm run check: +vitest +build)
```

## Acceptance Criteria
- [ ] `BENCH_PROFILES` has reconciled entries for `claude_code`, `codex`, `cursor` (real
      `capabilities()` values, not the ticket sketch) + `MOCK_BENCH_PROFILE`, with the
      reconciliation discrepancies recorded in a code comment.
- [ ] `runner.test.ts` passes inside the default gate for every registered harness's fixtures
      (no `drift`), including the new MCP-evidence fixtures.
- [ ] The fail-closed regression exists: a deliberately mismatched profile/fixture pair yields
      `drift` — asserted as not-`skip` and not-`pass`.
- [ ] Layer 1 replays through the real `parser.ts` / `normalizeCodex` / `RawTerminalTranscript`
      paths — zero bench-local parsing logic.
- [ ] `live-probes.test.ts` is fully inert without `AGENTAPP_BENCH_LIVE=1` and never fails on a
      missing CLI (`skip` verdict); probes use `mkdtemp` scratch repos only.
- [ ] `harness-bench-nightly.yml` exists, is not referenced by `ci/harness-gates.sh`, uploads
      JSON reports only; manual dispatch flagged as a post-push checklist item in the PR.
- [ ] `harness:benchReport` command appended end-to-end (shared type + narrowing handler);
      `src/shared/**` diffs are pure appends.
- [ ] No adapter file (`claude-code.ts` / `codex.ts` / `cursor.ts` / `raw-terminal.ts` /
      `parser.ts` / `mock.ts`) is modified.
- [ ] All Validation Gate blocking gates pass (run /verify).
