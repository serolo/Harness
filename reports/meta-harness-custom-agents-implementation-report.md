# Implementation Report: Meta Harness and File-Configured Agents

## Plan

`plans/meta-harness-custom-agents-plan.md`

## Orchestration

**Mechanism:** dependency-ordered main-session implementation with delegated production proxy work,
independent test authorship, adversarial verification, and heightened-scrutiny code review.

| Role | Responsibility | Outcome |
|---|---|---|
| main session | Plan Tasks 1–12, integration, remediation, gates, E2E | Implemented the complete production slice and remediated review findings |
| production worker | MCP stdio proxy, socket client, provider scoped-write hardening | PASS — real socket/stdio smoke and focused tests |
| test-author | Independent regression/coverage audit | PASS for changed behavior; identified the original browser-proof gap, since closed |
| verifier | Acceptance criteria and completion audit | Initial FAIL found Bearer redaction and interruption races; both remediated with regressions |
| code-review | IPC, filesystem, process/MCP, git/worktree, DB, secrets, packaging | Named current-tree verdict: `reports/meta-harness-custom-agents-review.md` |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Direct dependencies and packaged assets | DONE | Added `yaml` and the official MCP SDK; builder/vite package built-ins and the stdio proxy |
| 2 | Append-only shared contracts | DONE | Agent/run/dispatch/task contracts, commands/events, policies, consent, protocol identity |
| 3 | Safe normalized agent schema | DONE | Strict YAML, closed keys/enums, aliases/depth/size/count limits, exact snapshots/digests |
| 4 | Confined registry and bundle lifecycle | DONE | Immutable built-ins; create/import/duplicate/watch; symlink/path confinement; atomic multi-file create/edit/delete; last-valid recovery; file/line diagnostics |
| 5 | Durable storage and migration | DONE | Migration 0015, run/dispatch repositories, task snapshot metadata, CAS transitions, rollback note, safe scratch migration CLI |
| 6 | Capability-scoped broker and proxy | DONE | Four closed MCP tools, private socket/token, framing/replay/byte/rate checks, real stdio/socket transport |
| 7 | Meta service and claims | DONE | Coordinator/child supervision, claims, deadlines, continuation, cancellation, takeover, recovery, shutdown, exactly-once cleanup |
| 8 | Polly, Debby, Harness built-ins | DONE | Packaged role graphs, provider requirements, bundled skills, attribution, stable Debby protocol |
| 9 | Composition and typed IPC | DONE | Main wiring, narrow typed handlers/events, generic preload bridge, path-free native I/O errors |
| 10 | Scheduled-task integration | DONE | Stored snapshots/digests, staleness/refresh, firing/reconciliation, no-agent compatibility |
| 11 | Agents UI | DONE | Accessible peer tab, editor/add/remove files, import/duplicate/run, limits and consent, run inspector, Debby comparison |
| 12 | Proof and review | DONE | Deterministic real-broker E2E covers two children, continuation, Debby, cancellation/takeover, and stored-revision scheduled firing; named review and full gate were run |

## Key Implementation Areas

- `src/main/agents/**` — parser, snapshot validator, registry, built-ins, confinement rules.
- `src/main/meta-harness/**` — lifecycle service, broker, proxy transport, protocol enforcement.
- `src/main/db/migrations/0015_meta_agents.ts` and repositories — durable snapshots and state.
- `src/main/harness/**` — supervisor late-start interrupt and provider read-only/scoped-write modes.
- `src/main/integrations/github/pr.ts` — reviewed branch-only publish primitive reused after explicit run consent.
- `src/main/ipc/register.ts`, `src/main/context.ts`, `src/main/index.ts` — typed composition and boundaries.
- `src/renderer/features/agents/**`, `src/renderer/features/tasks/**` — Agents UI and scheduling.
- `resources/builtin-agents/**`, `docs/agent-config.md` — packaged definitions, attribution, grammar/security docs.
- `e2e/meta-harness.spec.ts`, `e2e/boot.spec.ts` — built Electron behavior and renderer hardening.

## Validation Results

| Validation | Result |
|---|---|
| Feature/affected tests | PASS — 29 files, 356 tests |
| Meta-harness Playwright | PASS — 5/5 (bundle recovery, two isolated children, continuation, Debby, cancel/takeover, stored-revision scheduled firing) |
| Full built Electron Playwright | PASS — 10/10 |
| lint | PASS |
| typecheck | PASS |
| build | PASS — includes `out/main/mcp-stdio.js` |
| dispatch isolation | PASS |
| dependency verification | PASS |
| changed-file Prettier | PASS |
| `git diff --check` | PASS |
| migration CLI | PASS — `--help` and isolated `--scratch` |
| unpacked package | PASS — all three built-ins under `Contents/Resources`; `out/main/index.js` and `out/main/mcp-stdio.js` in `app.asar` |
| full Vitest | BASELINE FAIL — 121 files pass, 1 untouched file fails; 1108/1112 tests pass, with 4 failures in `src/renderer/stores/harness.test.ts` and one existing sidebar async error |
| full repository Prettier | BASELINE FAIL — 34 untouched committed files |
| dependency audit | ADVISORY — 4 high and 1 moderate transitive findings |

## Acceptance Criteria

- [x] Immutable, valid Polly, Debby, and Harness built-ins with attribution and provider requirements.
- [x] Create, duplicate, import, inspect, add/remove/edit, validate, and recoverably delete project bundles from the Agents UI/domain path.
- [x] Safe root/child YAML, instructions, skills, providers, references, and bounded policies; executable fields rejected.
- [x] Exact validated snapshots/digests for manual and scheduled runs.
- [x] Four-tool capability MCP with no generic IPC/filesystem/database/git/merge authority.
- [x] Coordinator and child turns use `HarnessSupervisor` and claimed isolated workspaces.
- [x] Main-enforced fan-out, parallelism, depth, provider/role, request/result, turn, and run limits.
- [x] Polly independent review and PR-ready branches; explicit consent uses reviewed branch-only push/draft-PR paths; merge remains human-only.
- [x] Debby partner/critique/synthesis preservation and comparison UI, including duplicated-template protocol enforcement.
- [x] Harness PIV roles preserve independent test, verification, and review stages.
- [x] Accessible Agents peer tab; Knowledge remains non-executable.
- [x] Scheduled snapshots, staleness, refresh, firing/reconciliation, and no-agent compatibility.
- [x] Cancellation, takeover, recovery, and shutdown revoke authority, interrupt active work, release claims, and retain worktrees.
- [x] Append-only shared IPC; hardened renderer/preload; normalized path-free IPC errors.
- [x] Migration 0015 upgrade/idempotency/rollback/back-compat proof.
- [x] Comprehensive deterministic browser E2E and named heightened-scrutiny review.
- [ ] Literal full-gate criterion: blocked only by untouched baseline format/test failures.

## Review Findings Remediated

- Pending interrupts are delivered when an adapter resolves a late `startTurn` handle.
- Provider interrupts are idempotent across deadline, terminalization, repeated stop, and generic shutdown paths.
- Standard `Authorization: Bearer` headers are redacted from retained summaries and errors.
- UUIDv7 workspace names use their random tail, preventing rapid retained-worktree name collisions.
- Real Claude coordinators use a single strict MCP config and explicitly allow only the four broker tools.
- Debby uses a closed persisted `protocol` identity that survives duplication, not mutable slug/name.
- Run-start push/draft-PR consent is persisted and enforced through the existing reviewed branch-only workflow.
- Consented publication is run-owned and abortable before the run lock and through Git/execa, the
  PTY fallback, GitHub requests, and rate-limit waits; durable state is rechecked before each output.
- Adapter stream failures cross IPC and persistence only as sanitized typed `AppError`s.
- The editor and registry publish multi-file bundle changes atomically, removing the reference-order deadlock.
- Bundle discovery is streamed and entry-bounded; diagnostics retain child file plus YAML line/column.
- Native bundle I/O errors, recovery/shutdown logs, provider errors, and retained summaries redact secrets/absolute paths.
- Accidental debate columns were removed from `agent_runs` and asserted absent in migration tests.
- Takeover and service shutdown now have direct exactly-once lifecycle tests.
- Built launch resolves development resources correctly; the actual unpacked package contains the built-ins and both main/proxy entrypoints.

## Heightened-Scrutiny Boundaries

- **IPC/preload:** generic hardened bridge retained; all new handlers narrow input; native filesystem errors become stable typed path-free errors.
- **MCP/process lifecycle:** private token/socket, closed methods, response/request bounds, replay defense, strict Claude MCP/tool allowlist, deadline and exactly-once interruption, revocation-before-interrupt cleanup.
- **Filesystem:** allowed relative shapes, realpath containment, no symlinks/special files, streamed count/byte limits, validated atomic directory publication.
- **Git/worktree:** claims prevent cross-run use; child writes remain workspace-scoped; consented publishing is named-branch-only; merge API is absent.
- **Database/recovery:** additive migration, digest/schema validation, CAS terminal winner, boot interruption, rollback/data-loss note.
- **Secrets/tokens:** tokens stay outside argv/renderer/logs; errors and retained summaries are redacted; auth/control paths are never returned.
- **Packaging:** `extraResources` contains built-ins, build emits the proxy, packaged/development resolver seams are tested, built Electron boot passes, and `electron-builder --dir` contents were inspected.

## Handoff Status

All twelve implementation tasks and the feature-specific proof are complete, and the independent
heightened-scrutiny review passes with zero feature-scoped findings.
Literal repository-wide Definition of Done is not claimed because the pre-existing format and Vitest
baseline is not green: 34 untouched files fail Prettier and four untouched renderer-store tests fail.
