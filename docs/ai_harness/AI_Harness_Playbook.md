# The Harness AI Harness — Playbook & Overview

*The single reference for **what the agentic-SDLC harness is and how it's actually built in this
repo.** It opens with a short primer, then becomes entirely Harness-specific: the real files,
agents, gates, and hooks you can use right now.*

> **Companion:** [`DEVELOPER_WORKFLOW.md`](./DEVELOPER_WORKFLOW.md) is the step-by-step loop
> (spec → `/harness-plan` → `/harness-implement` → `/verify` → `/harness-review`) with the diagram.
> That doc is the source of truth for *the loop*; this one for *the implementation*.

---

## 1. Harness engineering in 60 seconds

**`Agent = Model + Harness`.** The model writes code; the *harness* is everything around it that
makes the output reliable rather than dependent on individual discipline — persistent context,
rules, specialised agents, verification loops, gates, and hooks. Two component types:

- **Guides** shape behaviour *before* the agent acts — context (`CLAUDE.md`), rules-as-code, agents,
  skills, deterministic policy hooks.
- **Sensors** give feedback *after* the agent acts — linter, type-checker, tests, the gate runner,
  AI review.

Checks are **computational** (deterministic — a linter, a test) or **inferential** (LLM-judged — AI
review). Prefer computational; use inferential where judgement is genuinely needed. The governing
discipline is the **failure-to-rule ratchet** (§6.4): rules are earned by real failures, promoted
review → gate when they become mechanically checkable, and retired when a better model makes them
redundant.

---

## 2. The implementation, at a glance

This harness was **ported from a backend monorepo and retargeted** to this Electron desktop app —
so it is deliberately trimmed: the parts that assumed a server, a Yarn monorepo, Jira, or a deploy
pipeline were dropped, and the parts that regulate *this* app were kept and rewritten.

### Guides → sensors, mapped to real files

| Layer | Concept | Concrete artifact(s) in this repo |
|---|---|---|
| **Guide** | Persistent context | Root `CLAUDE.md` + nested (`src/main/ipc`, `src/main/pty`, `src/main/git`) |
| **Guide** | Rules-as-code | `.claude/rules/{security,architecture,conventions}.md` (`[GATE]`/`[REVIEW]`) |
| **Guide** | Specialised agents | `.claude/agents/*` — 9 agents (§4.3) |
| **Guide** | Skills | `.claude/skills/*` — `harness-plan`, `harness-implement`, `harness-review`, `harness-improve` |
| **Guide** | Slash command | `.claude/commands/verify.md` — the `/verify` evidence loop |
| **Guide** | Deterministic policy hooks | `.claude/hooks/*` — block-on-main, security-guard, post-edit-checks, stop-validate |
| **Sensor** | The gate runner | `ci/harness-gates.sh` (7 gates, BLOCKING/ADVISORY) |
| **Sensor** | Evidence-before-done | `/verify` + the `verifier` agent + the Stop hook |
| **Sensor** | AI review | the `code-review` agent (via `/harness-review`) |

`[GATE]` = auto-enforced, build fails. `[REVIEW]` = judgement call by the AI + a human reviewer.

---

## 3. The stack we wrap (detected)

| Concern | This repo (`harness`) |
|---|---|
| Kind | Electron **desktop app** (main / preload / renderer / shared), built in phases against a spec |
| Language / build | TypeScript (strict, `tsc -b` project refs), **electron-vite** |
| Package manager | **npm** (`package-lock.json`) |
| Main process | `git` (execa v9, ESM-only), `pty` (node-pty), `db` (better-sqlite3), `ipc`, `workspace`, `process`, `settings`, `integrations` |
| Renderer | React 18, **Tailwind CSS**, **Zustand**, **@tanstack/react-query**, Radix UI, `@xterm/xterm`, `@monaco-editor/react` |
| IPC | Typed, frozen, append-only contract in `src/shared/ipc.ts` (Commands / Events / StreamChannels) — no codegen |
| Tests | **Vitest-under-Electron** (`node scripts/vitest-electron.mjs`); Playwright E2E |
| Lint / format | ESLint (`.eslintrc.cjs`) + Prettier (`.prettierrc`) |
| Observability | Local desktop app — no server telemetry stack; main-process logs + (optional) crash reporting |

---

## 4. Guides — shaping behaviour before the agent acts

### 4.1 Context layer — the `CLAUDE.md` hierarchy
Root `CLAUDE.md` (repo-wide non-negotiables + Definition of Done) plus the nearest nested one for
the subsystem you're in. This repo starts with a **handful** (root + `ipc`/`pty`/`git`), not
hundreds — add one when a subsystem's logic is non-obvious (a Definition-of-Done item).

### 4.2 Rules-as-code (`.claude/rules/`)
Three lean, tagged files: **`security.md`** (heightened-scrutiny paths, §8), **`architecture.md`**
(the main/preload/renderer boundary, the typed-IPC-channel rule), **`conventions.md`** (npm,
`*.test.ts` via vitest-electron, the gate). Where a `[REVIEW]` rule becomes mechanically checkable,
promote it to `[GATE]` and wire it into `harness-gates.sh` — that promotion *is* the work (§7).

### 4.3 The agent library (`.claude/agents/`)
Nine specialists; model tiering is deliberate cost management.

| Agent | Model | Phase | Reach for it when… |
|---|---|---|---|
| **spec-writer** | sonnet | Ready | A request is thin — scope it + flag ambiguity before code |
| **deep-dive** | opus | Plan | Depth matters — plan/risk review, unfamiliar-code mapping, hard bug |
| **coder** | opus | Implement | Build/refactor production code to the house rules |
| **frontend-designer** | sonnet | Implement (UI) | Renderer UI — React + Tailwind + Radix, the process boundary |
| **test-author** | sonnet | Implement (tests) | Tests *independent* of the coder; failing-first for bugs |
| **verifier** | sonnet | Validate | Refute "done" with evidence (completion-truth) |
| **code-review** | opus | Review | Judge *quality* — rules + acceptance criteria + severity + PASS/FAIL |
| **release-notes** | haiku | Release | Turn merged PRs/commits into a changelog |
| **incident-responder** | opus | Monitor | **Read-only** triage of app failures (logs / IPC / git / pty / db) |

Separation of concerns is the point: `test-author` ≠ `coder`; `verifier` (completion) ≠ `code-review`
(quality); `incident-responder` recommends, never mutates.

### 4.4 Skills, `/verify`, and hooks
Skills: the PIV loop (`harness-plan/implement/review`) + the meta-loop (`harness-improve`).
`/verify` is the evidence loop (§5.2). Deterministic policy hooks, wired in `.claude/settings.json`:

| Hook | Event | Behaviour |
|---|---|---|
| **block-on-main** | PreToolUse (Edit/Write) | Can't edit on `main`/`master` — branch first. *Fails open if git can't resolve.* |
| **security-guard** | PreToolUse | Hard-denies real `.env` access + recursive deletes (`rm -rf`, `find -delete`, `git clean -d/-f/-x`) — even under `--dangerously-skip-permissions`. A blast-radius guard, not a secret-scanner. |
| **post-edit-checks** | PostToolUse (Edit/Write) | Non-blocking `prettier --write → eslint --fix` on the touched file. |
| **stop-validate** | Stop | **Blocking** — `prettier -c` + `eslint` on changed files; won't let the agent finish until clean. Escape `SKIP_STOP_VALIDATE=1`. *Fails open if git can't list changes.* |

### 4.5 MCP servers
No MCP config is committed in this repo today. Add one under `.claude/` if/when an external
integration is needed.

---

## 5. Sensors — feedback after the agent acts

### 5.1 The gate runner — `ci/harness-gates.sh`
One deterministic runner, local == whatever CI you add later. Gates: `format` `lint` `typecheck`
`tests` `build` `deps_verify` (BLOCKING) and `deps_audit` (ADVISORY). No-arg runs the full ordered
set; pass gate names for a subset; `SKIP_GATES="…"` to skip. Exits non-zero on the first failing
BLOCKING gate; ADVISORY gates warn but never fail. (Full table in the
[Workflow §5](./DEVELOPER_WORKFLOW.md).)

### 5.2 Evidence-before-done — `/verify`, the `verifier` agent, the Stop hook
`/verify` is the 6-step evidence loop (restate → gate → name the test → show the behaviour → walk
the DoD → self-critique). The **`verifier`** agent judges *truth of completion*. It's **enforced**:
the Stop hook is the deterministic backstop behind "show evidence, don't assert."

---

## 6. The loop (PIV)
Plan → Implement → Validate (+ Review), wrapped by Ready in front and Review behind. The
command-by-command walkthrough + diagram live in
[`DEVELOPER_WORKFLOW.md`](./DEVELOPER_WORKFLOW.md); this doc doesn't restate it.

## 7. The meta-loop — `/harness-improve`
Every stage above *consumes* the harness; this is the one that *writes back to it*. Two modes —
**Capture** (route a concrete, traceable learning to its right home + format) and **Audit** (scan
for `[REVIEW]`→`[GATE]` promotions, rule-noise, retire candidates, gaps). It **proposes before it
edits** — these files load into every session — and treats a `[GATE]` tag with no matching
enforcement as a lie.

## 8. Guardrails for *our* risks
**Heightened-scrutiny paths — named human review required** (`security.md` flags them; `code-review`
calls them out): the **IPC / preload boundary** (the renderer trust boundary), **process / PTY
execution** (arbitrary-command surface), **git / filesystem on user workspaces** (destructive ops +
path traversal), **db / migrations**, **secrets / tokens**, **packaging / updates**. Plus the
structural non-negotiables: renderer hardening, the **frozen append-only `src/shared/**` contract**,
and the typed IPC error boundary (root `CLAUDE.md`).

## §6.4 — The failure-to-rule ratchet

> *"Every line in a good rules file should be traceable to a specific thing that went wrong."*
> Corollary — **rule-noise**: *"more rules make each rule matter less."*

So the harness is a **ratchet, not a wish-list**:

1. **No rule without a traceable failure.** Can't name what went wrong? Don't add the rule.
2. **Guard against rule-noise.** Refine an existing rule in place before appending a near-duplicate.
3. **Promote `[REVIEW]` → `[GATE]` over time.** Anything a linter/script can check *today* should
   become a gate wired into `ci/harness-gates.sh`. Moving rules review → gate *is the work*.
4. **The ratchet retires, too.** A rule made redundant by a gate or a better model is removed.

## Honest gaps

The enforcement spine (rules, hooks, `/verify`, the gate runner, the context layer) is in place.
Be candid about what is **not**, relative to a mature harness:

| Status | Item |
|---|---|
| ⚠️ Open | **Detached-git degradation** — `block-on-main` + `stop-validate` fail open (no-op) until the repo's git link is repaired; then full enforcement returns with no hook changes. |
| ⚠️ Open | **No CI / PR automation** — no GitHub Actions floor, no `/claude-review`, no auto-merge. Review is local (`/harness-review`) + a human. |
| ⚠️ Open | **Secret-scanning / SAST** (`secrets`/`security` gates) not wired — add a `run_gate` branch (gitleaks / `npm audit` is only advisory today). |
| ⚠️ Open | **`deps_verify` hits the network** (`npm install --dry-run`) — skip it offline via `SKIP_GATES`. |
| ⚠️ Open | **No as-code monitoring** and **no `evals/` baseline** — the "a monitor exists" step and golden-task measurement are manual/absent. |
| ⚠️ Open | **Behaviour verification leans on AI-written tests** — no mutation testing checks the tests test the right thing. |

Each is added only when a real failure or a real model gain justifies it (the ratchet, §6.4).

## 9. Extending the harness
Use **`/harness-improve`** (§7) rather than a green-field re-install: merge-aware, propose-before-edit,
additive. Never overwrite existing `.claude/` content; work on a branch; rely on git as the safety net.
