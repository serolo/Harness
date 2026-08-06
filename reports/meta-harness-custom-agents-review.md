# Meta Harness and Custom Agents — Code Review

## Automated Checks Results

- `bash ci/harness-gates.sh lint typecheck`: **PASS**.
- Focused affected suite: **PASS** — the original 25-file feature suite passed, and the final six-file lifecycle/publication remediation suite passes 129/129 tests.
- `npm run build`: **PASS**; the build emits `out/main/mcp-stdio.js`.
- `npx playwright test`: **PASS** — 10/10, including renderer hardening and the five-scenario meta-harness matrix.
- `git diff --check`: **PASS**.
- Repository-wide baseline `bash ci/harness-gates.sh`: **NOT GREEN (separate baseline)** — it stops at the format stage because 34 committed, untouched files do not satisfy Prettier.
- Repository-wide baseline Vitest (`node scripts/vitest-electron.mjs run`): **NOT GREEN (separate baseline)** — 121 files pass and 1 existing file fails; 1108/1112 tests pass, with four failures in `src/renderer/stores/harness.test.ts` plus one existing unhandled sidebar error.

The two repository-wide failures above pre-date and are outside this feature diff; they remain release/Definition-of-Done debt, but are not feature blockers in this verdict. Skipped/unconfigured checks are not counted as passes. A packaged installer was not launched; packaging evidence consists of the builder configuration, packaged/development path tests, emitted proxy artifact, and built-Electron tests.

## Intent / Spec Context

Intent comes from `plans/meta-harness-custom-agents-plan.md` and `reports/meta-harness-custom-agents-implementation-report.md`. The change implements immutable packaged agents, safe project bundles, durable snapshots/runs/dispatches, a four-tool capability broker, supervised isolated workspaces, Debby/Harness/Polly protocols, scheduled-agent execution, typed IPC, the Agents UI, consented branch publication, and deterministic Electron E2E coverage.

The current tree fixes the earlier review defects: Debby uses persisted protocol identity, UUIDv7 random tails identify retained worktrees, Bearer/secret/path sanitization covers retained and boundary errors, migrations no longer alter unrelated run columns, Claude's meta coordinator uses one strict MCP configuration with four exact allowed tools, and process interruption is deduplicated across pending handles, repeated requests, coordinator timeout, and shutdown. Publication now has run-owned cancellation propagated through durable arbitration, Git/execa and the EBADF PTY fallback, GitHub requests, and rate-limit waits. Adapter stream failures cross the boundary as sanitized `AppError`s.

## Requirements Check

| Acceptance criterion | Status | Evidence / gap |
|---|---|---|
| Immutable valid Polly, Debby, and Harness built-ins | MET | Packaged YAML is parsed through the production registry path and exercised by unit/E2E tests. |
| Create/import/duplicate/edit/delete custom bundles safely | MET | Atomic multi-file publication, trash deletion, diagnostics, recovery, and UI flows are covered. |
| Safe bounded YAML schema | MET | Closed keys/enums, file/count/byte/depth bounds, references, skills, and executable-field rejection are main-owned. |
| Exact snapshot/digest per manual or scheduled run | MET | Durable snapshot columns/repositories and scheduled stale-revision E2E pass. |
| Four-tool capability-scoped MCP, no generic authority | MET | Private broker plus Claude `--strict-mcp-config` and the four exact `--allowedTools`; no merge tool/API exists in the broker. |
| Coordinator/children use supervisor and isolated claimed workspaces | MET | Admission guard, `WorkspaceManager` creation, UUID-tail uniqueness, and fan-out E2E pass. |
| Main-enforced fan-out/depth/provider/size/time limits | MET | Service and adversarial broker/deadline tests pass. |
| Polly independent review and human merge authority | MET | Independent-provider checks and explicit run-start push/draft-PR consent are enforced; merge is absent. |
| Debby preserves both answers, critiques, and synthesis | MET | Durable protocol metadata and comparison E2E pass. |
| Harness preserves independent PIV stages | MET | Built-in role graph/config validation passes. |
| Accessible Agents peer tab; Knowledge remains non-executable | MET | Renderer tests and Electron E2E pass. |
| Scheduled agent snapshots and no-agent compatibility | MET | Scheduler/repository tests and stored-revision E2E pass. |
| Cancel/takeover/recovery/shutdown revoke, interrupt exactly once, and retain worktrees | MET | Stop/expiry abort publication before lock acquisition; Git, PTY fallback, GitHub request/rate waits, provider interruption, authority revocation, and claim cleanup have focused race regressions. |
| Append-only IPC, hardened renderer, normalized error boundary | MET | Shared entries are appended, handlers narrow inputs, boot/IPC E2E pass, and adapter stream errors are sanitized before forwarding and persistence. |
| Migration 0015 upgrade/rollback/back-compat | MET | Additive migration and rollback/idempotency tests pass; the data-loss note is present. |
| Deterministic E2E and named heightened-scrutiny review | MET | Full Playwright passes 10/10 and this review names every required boundary. The unrelated repository-wide baseline remains separately not green. |

## Code Review Summary

- Total issues: 0 · Critical: 0 | High: 0 | Medium: 0 | Low: 0

## Heightened-Scrutiny Review

- **IPC / preload — PASS.** New commands/events are appended to the frozen maps. Renderer access remains through the generic typed `window.api`; `contextIsolation`, `sandbox`, and `nodeIntegration: false` are intact. Main handlers validate IDs/projects/file shapes and use the encoded `AppError` boundary. Both event and adapter stream-error messages are sanitized before crossing; Electron IPC/hardening tests pass.
- **MCP / process — PASS.** The stdio proxy is transport-only. The broker exposes a closed four-method union, validates token/replay/message/request/result/deadline bounds, uses private 0600 artifacts, and revokes sockets before interruption. Claude meta runs use `--strict-mcp-config` plus exactly four allowed MCP tools. Pending and repeated interrupts are delivered once. Publication abort reaches execa and the EBADF PTY fallback, including already-aborted and listener-registration races.
- **Filesystem — PASS.** Agent discovery is streamed and entry/byte bounded; reads and atomic writes are relative, realpath-confined, and reject symlinks/special files. Native failures are normalized before IPC/log persistence. Worktrees are retained rather than recursively deleted.
- **Git / worktree — PASS.** Workspace claims are enforced at supervisor admission, retained names use random UUID tails, writes stay in isolated worktrees, publication targets the workspace's named branch, requires persisted run-start consent, and cannot merge. A per-run abort signal reaches status, commit, upstream lookup, push, PTY fallback, HTTP, and primary/secondary rate waits; durable run state is checked before every output. Meta PR publication always supplies a bounded body, including an explicit empty body, so it cannot fall into unrelated non-abortable diff derivation.
- **Database / recovery — PASS.** Migration 0015 is additive and registered with rollback/back-compat notes. Runs/dispatches use repository-owned CAS transitions; stale runs/dispatches are interrupted on boot, broker authority is revoked, claims are released, and worktrees remain.
- **Secrets / tokens — PASS.** Capability tokens are absent from argv, renderer DTOs, and logs; token/socket artifacts are private and removed. Bearer headers, secret assignments, provider summaries, native paths, recovery/shutdown errors, normalized error events, and adapter `sink.error()` failures are sanitized before crossing or persisting.
- **Packaging — PASS with a smoke-test limitation.** Builder resources place built-ins at the packaged resolver location, Vite emits the proxy entry, and development/packaged path seams plus the built proxy transport are tested. The built Electron suite passes; an actual packaged installer/runtime was not launched in this review.

## Positive Observations

- The latest remediations target the real invariants rather than special-casing tests: UUIDv7 tail entropy prevents retained-branch collisions, and interrupt delivery is idempotent at both service and supervisor layers.
- The Claude provider now enforces the same closed MCP capability set as main, preventing user/project/global MCP configuration from broadening coordinator authority.
- Cancellation is owned end-to-end: abort wins before the run lock, propagates through every publication wait/process, and each output rechecks the durable terminal winner.
- The deterministic E2E matrix keeps registry, IPC, scheduler, DB, broker, workspace creation, and UI real while replacing only the external provider boundary.

## Verdict: PASS

No feature-scoped blockers remain. The meta-harness/custom-agents implementation passes this code and heightened-scrutiny review. The separate repository-wide Prettier/Vitest baseline must still be made green (or explicitly accepted by the owner) before the repository as a whole satisfies its literal Definition of Done.
