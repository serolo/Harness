---
name: harness-implement
description: PIV step 2. Read a plan file, execute every task in dependency order with per-task validation, then write an implementation report to reports/<slug>-implementation-report.md. Invoke explicitly with /harness-implement <plan-path>.
disable-model-invocation: true
---

# /harness-implement — Execute a Feature Plan (PIV step 2)

**Usage:** `/harness-implement plans/<feature-slug>-plan.md`

Reads the plan at `$ARGUMENTS`, executes every task in order with per-task validation, then writes
an implementation report. Step 2 of the **PIV loop** — see `docs/ai_harness/DEVELOPER_WORKFLOW.md`.

> You **drive the agents** named in the plan's `## Execution Strategy`. Delegate production code to
> the **coder** agent and tests to the **test-author** agent (so the agent that decides what "tested"
> means didn't write the code). Both must obey the house rules in the root `CLAUDE.md` and
> `.claude/rules/` — restate that in every agent prompt. You run in the **main session**: only you can
> create a team or fan out subagents, because a spawned agent/teammate cannot spawn further agents.

## Process

### 1. Read the full plan + its Execution Strategy
Open the plan file in `$ARGUMENTS` and read it entirely before writing code, including the
`## Execution Strategy` section (pattern, agent roster, parallel decomposition + file-ownership). Load
any nested `CLAUDE.md` / `.claude/rules/` referenced in its "Read before implementing" section.

### 2. Select the orchestration mechanism (capability check, once)
The plan picks the *pattern + roster*; you pick *team vs subagent* now, at runtime:
1. Run `printenv CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` and check whether the `TeamCreate` tool is
   available to you.
2. If it returns `1` **and** `TeamCreate` is available → **team path**. Otherwise → **parallel-subagent
   path** (the agent-teams feature is experimental and off by default, so this is the normal path).
3. If the plan's pattern is `single-agent`/`sequential`, skip fan-out entirely and implement directly.

### 3. Execute the strategy
Honor the plan's pattern. In **all** branches keep the per-task discipline: **read** the target
file(s) before editing (never overwrite blindly), implement mirroring the stated Pattern reference +
house rules, **run each task's `Validate:` command immediately** and fix before moving on, and for a
bug fix write the **failing regression test first** (test-author) then make it pass. The PostToolUse
hook auto-formats + lints each file touched; the PreToolUse guards block edits on `main`, real `.env`
access, and recursive deletes.

- **Team path:** create a team; add members per the roster; create tasks carrying the plan's
  dependencies + **file-ownership boundaries** (so teammates never touch the same file); let teammates
  work in parallel (peer messaging for competing-hypothesis exploration / cross-checks); monitor and
  steer; collect outputs; then — as the lead (this session) — **delete the team** when done.
- **Parallel-subagent path:** issue the independent `coder` / `test-author` / `deep-dive` Agent calls
  **in a single message** so they run concurrently, each prompt stating the files it owns + the house
  rules; then integrate the returned diffs/results in the main session.
- **Sequential / single-agent path:** chain the tasks in dependency order as the default for trivial
  or strictly-dependent work.

After integration, run any cross-cutting tasks that depend on multiple agents' output, then proceed
to the gate.

### 4. Run the full validation gate
After all tasks, run the gate from the plan's "Validation Gate" — the same one the **Stop hook**
enforces and that `/verify` runs:
```
bash ci/harness-gates.sh     # full gate → npm run check (tsc -b, eslint, vitest, electron-vite build)
```
If anything fails: fix, re-run that gate, then re-run the full set. Do not declare done until every
blocking gate is green. (Run `/verify` to produce the evidence write-up.)

### 5. Write the implementation report
Use the **Write tool** to create `reports/<feature-slug>-implementation-report.md`:

```markdown
# Implementation Report: <Feature Name>

## Plan
`plans/<feature-slug>-plan.md`

## Orchestration
**Mechanism:** team | parallel-subagents | sequential   *(if the strategy named a team but the
experimental flag was off, note the fallback)*
| Agent / role | Task(s) | Outcome |
|---|---|---|
| coder (module A) | <tasks> | DONE |

## Tasks Completed
| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | <description> | DONE | |

## Files Changed
- **Created:** `<path>`
- **Modified:** `<path>` (lines N–M)

## Validation Gate Results
| Gate | Result |
|------|--------|
| format | PASS |
| lint | PASS |
| typecheck | PASS |
| tests | PASS (the test that exercises the new behaviour: `<name>`) |

## Acceptance Criteria
- [x] <criterion>

## Issues / Deviations
<any deviation from the plan and why>

## Heightened-scrutiny paths touched
<IPC/preload boundary, process/PTY execution, git/fs on user workspaces, db/migrations, secrets/tokens, packaging — or "none">

## Ready for Review
All tasks done; all blocking gates green.
```

**Handoff:** run `/verify` (evidence), then `/harness-review` (or comment `/claude-review` on the PR).
