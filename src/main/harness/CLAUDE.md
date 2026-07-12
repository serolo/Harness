# src/main/harness — agent adapters + the conformance bench

Adapters implement the **frozen** `Harness` contract (`@shared/harness`, README §6.3) over the
user's installed agent CLIs: `claude-code.ts` (stream-JSON via the pure `parser.ts`), `codex.ts`
(assumed stream-JSON via `normalizeCodex`), `cursor.ts` (raw terminal via `raw-terminal.ts`), plus
the deterministic `mock.ts` used under `AGENTAPP_MOCK_HARNESS`/`AGENTAPP_E2E`. Do not change an
adapter's parsing to satisfy a downstream consumer — the parsers are contract-tested from recorded
fixtures under `./fixtures/**`.

## Conformance bench (Phase 8, `./bench/`)

An executable check that an adapter's **declared** `HarnessCapabilities` / event surface has not
silently drifted from what its code actually produces. Two layers:

### Layer 1 — offline fixture replay (default gate)

`bench/runner.ts` `runLayer1(profile, fixtures)` replays fixture files through the adapter's OWN
exported functions — `createJsonLineSplitter()` + `normalize()` (claude_code), `normalizeCodex()`
(codex), the real `RawTerminalTranscript` driven by a fake in-process spawner (cursor) — and grades
`bench/profiles.ts`'s `BENCH_PROFILES` against the observed `AgentEvent` stream. There is **zero
bench-local parsing**; if an adapter changes its mapping, the bench sees it automatically.

**What Layer 1 proves — and does NOT.** It proves *fixtures ↔ profile consistency* only. It is NOT
live-CLI conformance: the fixtures are hand-authored samples (see each adapter header), so a green
Layer 1 does not prove fidelity to the current CLI output. Treating it as such is the documented
false-confidence risk — live conformance is Layer 2.

`runLayer1` is `async` because the raw-terminal transport is timer-driven. It reads only the files it
is handed (always paths under `./fixtures/**`) and spawns nothing; the module is native-free
(no `better-sqlite3`/`node-pty` in its import graph).

### Layer 2 — live CLI probes (env-gated, nightly)

`bench/live-probes.ts` (`runBasicTurn` / `runPolicyTurn` / `runInterrupt`) drives a REAL `startTurn`
against a REAL CLI. Gated behind **`AGENTAPP_BENCH_LIVE=1`** — fully inert in the default gate — and
run by `.github/workflows/harness-bench-nightly.yml`, which uploads the JSON reports as an artifact
and writes them to `BENCH_REPORT_DIR`. A missing CLI yields a `skip`, never a failure.

**Scratch-repo isolation is load-bearing.** The turn's `workspaceDir` comes ONLY from `fs.mkdtemp`
(never a project/workspace path); every external command (`git init`, `pgrep`) is an `execa`
arg-array (never a shell string); the turn is interrupted and the dir `rm -rf`'d in `finally`.
`detail` strings carry only sanitized reasons — never CLI stdout/stderr/env (which can hold secrets).

### Verdicts and the capability-evidence table

`BenchVerdict` is three-valued: `pass` (behaviour observed, or a flag declared `false` — absence is
not drift), `drift` (profile contradicted — the fail signal), `skip` (not observable through the
available evidence; **never** a fabricated `pass`).

| Capability (declared `true`)         | Layer-1 evidence                                             |
| ------------------------------------ | ----------------------------------------------------------- |
| `supportsResume`                     | a session capture seen during replay (`resume.jsonl`)       |
| `supportsMcp`                        | a `tool_use` event whose `name` starts `mcp__` (`mcp_tool_use.jsonl`) |
| `supportsPlanMode`                   | **skip** — spawn/argv affordance, not in any recorded stream |
| `rawTerminalFallback`                | **skip** — spawn affordance, not in any recorded stream      |
| any flag declared `false`            | trivial **pass** — absence is not drift                      |

`expectedEventKinds` is a `pass` when every declared kind is witnessed across the fixture union,
else `drift` naming the missing kinds. An empty `fixtures.files` yields a single `skip` (never
`pass`).

### Profile ↔ ticket reconciliation (finding recorded on `BENCH_PROFILES`)

The Phase-8 ticket's illustrative capability values were wrong for two adapters; `BENCH_PROFILES`
uses the REAL values read off the adapters:

- **claude_code** — all four flags `true` (ticket wrongly said `rawTerminalFallback: false`).
- **codex** — `supportsResume:true, supportsMcp:true, supportsPlanMode:false, rawTerminalFallback:true`
  (ticket wrongly said all four `false`). `normalizeCodex` never emits `tool_result`/`todo_update`,
  so those kinds are absent from codex's `expectedEventKinds`.
- **cursor** — `supportsResume:false, supportsMcp:false, supportsPlanMode:false,
  rawTerminalFallback:true` (matches the sketch).

`MockHarness` reuses the frozen `claude_code` id, so it is not a fourth `BENCH_PROFILES` key — its
profile is the separate `MOCK_BENCH_PROFILE`.

## Diagnostics IPC

`harness:benchReport` (`{ harnessId } → BenchReport | null`) is a read-only command that returns the
latest report from the in-memory `BenchReportStore` (`ctx.benchReports`). The handler narrows
`harnessId` to a known id (throws `invalid_input` otherwise) and never runs the bench itself.
