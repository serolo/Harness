---
name: harness-plan
description: PIV step 1. Analyze a ticket/feature against this codebase and write a context-rich, task-by-task implementation plan to plans/<slug>-plan.md. No code is written. Invoke explicitly with /harness-plan.
disable-model-invocation: true
---

# /harness-plan — Analyze + Plan a Feature (PIV step 1)

**Usage:** `/harness-plan <ticket-id-or-feature-description>`

Produces a durable implementation plan at `plans/<feature-slug>-plan.md`. **No code is written
in this phase.** This is the first step of the **PIV loop (Plan → Implement → Validate)** — see
`docs/ai_harness/DEVELOPER_WORKFLOW.md`.

> **Relationship to plan mode and `spec-writer`:** plan mode is ephemeral (its plan isn't
> committed to the repo); `/plan` writes a **durable artifact** that `/implement` reads in a later
> session. `spec-writer` answers *"is this ready to build?"* (Definition of Ready — scope,
> ambiguity, acceptance criteria); `/plan` answers *"how do we build it here?"* (files, tasks,
> validation). Run `spec-writer` first if the ticket is thin; delegate the heavy codebase analysis
> below to the **deep-dive** agent for gnarly/cross-cutting work.

## Process

### 1. Understand the request
From `$ARGUMENTS` extract: feature type (new capability / enhancement / bug fix / refactor),
affected layers (model / handler / route / service / gateway / frontend / migration), and the
acceptance criteria. If the ticket is ambiguous, **flag it and stop** — don't guess (run
`spec-writer`).

### 2. Read the codebase
Load `.claude/rules/{security,architecture,conventions}.md` (and the nearest `CLAUDE.md`, if the
area you're touching has one). Then read:
- Every existing file you will **modify** (get real line numbers).
- The closest **analogue** to what you're building (e.g. a new IPC feature → read an existing
  handler in `src/main/ipc/*` + its `src/preload/*` bridge method + the `src/renderer/ipc/*`
  client + shared types in `src/shared/*` + the nearest `*.test.ts`).
- For investigation-heavy work, delegate to the **deep-dive** agent and fold its findings in.

### 3. Think through risks (this Electron app)
- Process-boundary traps: does this cross the main↔renderer line? The renderer stays sandboxed
  (`contextIsolation`, no `nodeIntegration`); a new capability is a **typed IPC channel** —
  handler in `src/main/ipc/*` → `src/preload/*` bridge → `src/renderer/ipc/*` client →
  `src/shared/*` types. See `.claude/rules/architecture.md`.
- **Heightened-scrutiny paths** (`.claude/rules/security.md`): the IPC/preload boundary,
  process/PTY execution (`src/main/process`, `src/main/pty`), git/filesystem on user workspaces
  (`src/main/git`, `src/main/workspace`, `src/main/diff`, `src/main/checkpoint`), db/migrations
  (`src/main/db`, `scripts/migrate.ts`), secrets/tokens (`src/main/settings`,
  `src/main/integrations`), and packaging/updates. Validate & narrow all IPC inputs; never build
  shell strings from untrusted or workspace-derived input.
- Migration needed? (any schema change in `src/main/db` → a migration in `scripts/migrate.ts`
  plus a rollback/back-compat note; SQLite lives on the user's disk).
- Test-coverage gap: what could regress that isn't covered.

### 4. Choose the execution strategy
Decide **how** `/harness-implement` should build this — which orchestration pattern and which agents — from
the task's shape (topology × complexity × risk). Record the choice in the plan (see the
`## Execution Strategy` section below). **Default to the lightest option that fits**; only escalate to
parallelism/teams for genuinely independent multi-module or long-horizon work — multi-agent setups
cost more tokens and add coordination overhead, so most tasks want a single augmented agent.

| Task shape | Pattern | Agent roster | Orchestration |
|---|---|---|---|
| Trivial / single-file / low-risk | single augmented agent | `coder` (tests inline, or `test-author` after) | none — main session / one subagent |
| Standard feature, one bounded topology (new endpoint, one worker, one migration) | prompt-chaining + evaluator-optimizer | `coder` → `test-author` (parallel) → `code-review` + `verifier` | parallel subagents |
| Investigation-heavy / unfamiliar area | orchestrator-workers, parallel exploration | 2–3 `deep-dive` (competing hypotheses) → synthesize | team if enabled (peer messaging), else parallel subagents |
| Cross-cutting / multiple **independent** modules | parallelization (sectioning) | one `coder` per module + `test-author` per module | **team** (each teammate owns a module via the shared task list; no file conflicts) → fallback parallel subagents |
| High-stakes / heightened-scrutiny (IPC/preload boundary, process/PTY exec, git/fs on user workspaces, db migration, secrets) | evaluator-optimizer + voting | `coder` → `test-author` → `code-review` + `verifier` (mandatory) | parallel subagents + mandatory `verifier` |

Record the **pattern + roster** (static). Leave the **team-vs-subagent mechanism** to a runtime
capability check in `/implement` (the agent-teams feature is experimental and off by default — see
the `## Execution Strategy` note). For investigation-heavy planning, you may fan out parallel
`deep-dive` agents in *this* step and fold their findings in.

### 5. Write the plan to a file
Use the **Write tool** to create `plans/<feature-slug>-plan.md` — a **required deliverable**, not
optional (`/implement` reads it from disk). Structure:

```markdown
# Plan: <Feature Name>

## Ticket / Feature
<ticket id or feature description, one sentence>

## Affected Files
### Read before implementing
- `<path>` (lines N–M) — <why / what to mirror>
### Modify
- `<path>` — <what changes>
### Create
- `<path>` — <purpose>

## Ordered Tasks
### Task 1 — <action> <target>
- What: <specific change>
- Pattern: `<path>:L<line>` — <what to mirror>
- Gotcha: <known house-rule trap / heightened-scrutiny note, if any>
- Validate: `<exact command>`   # e.g. node scripts/vitest-electron.mjs run src/main/git/index.test.ts
### Task 2 — ...
(continue in dependency order)

## Execution Strategy
*How `/harness-implement` should build this. `/harness-implement` reads this verbatim.*
- **Task shape:** <topology + complexity/risk, from the step-4 table>
- **Pattern:** single-agent | prompt-chaining | parallelization | orchestrator-workers | evaluator-optimizer
- **Agents:** <roster with roles, e.g. coder (module A) · coder (module B) · test-author · code-review · verifier>
- **Orchestration:** prefer team if `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` enabled, else parallel subagents | sequential
- **Parallel decomposition + file-ownership:** <which Ordered Tasks are independent and can run concurrently; which files each agent owns, so parallel work never touches the same file>
- **Rationale:** <one line: why this strategy for this task shape>

## Validation Gate
Run after all tasks (from repo root):
\`\`\`
bash ci/harness-gates.sh format lint typecheck   # fast inner loop
bash ci/harness-gates.sh                          # full gate before PR (npm run check: +vitest +build)
\`\`\`

## Acceptance Criteria
- [ ] <measurable criterion>
- [ ] All Validation Gate blocking gates pass (run /verify)
```

### 6. Confirm
After writing, output: the path `plans/<slug>-plan.md`, Complexity (Low/Medium/High), the chosen
execution strategy (pattern + roster), key risks, and a Confidence score (N/10 that `/implement`
succeeds first-pass).

**Handoff:** `/harness-implement plans/<feature-slug>-plan.md`.
