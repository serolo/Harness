---
name: harness-review
description: PIV step 4 (local). Delegate the working-tree diff to the code-review agent, judge it against .claude/rules and the ticket's acceptance criteria, and write reports/<slug>-review.md. Invoke explicitly with /harness-review. For the PR-time AI review, comment /claude-review instead.
disable-model-invocation: true
---

# /harness-review — Review the Change (PIV step 4)

**Usage:** `/harness-review [feature-slug]`

The local code-review step of the **PIV loop**. (PIV step 3 — *Validate* — is the existing
`/verify` command + the Stop hook; there is no separate `/validate` skill, by design.)

> **Don't duplicate the PR review.** On a PR, the canonical AI review is the **`/claude-review`**
> comment (→ `pr-claude-code-review.yml` → the `code-review` agent). Use `/harness-review` for a *local*
> pass before you open the PR, and for leaving a durable report artifact.

## Process

1. **Gather the diff** — `git diff` against the base branch (usually `main`; diff against
   whatever this feature branch actually targets).
2. **Delegate to the `code-review` agent.** It runs lint/types, judges quality against
   `.claude/rules/{security,architecture,conventions}.md`, validates the ticket's acceptance
   criteria, severity-grades findings (CRITICAL→LOW), calls out heightened-scrutiny paths
   (IPC/preload boundary, process/PTY execution, git/fs on user workspaces, db/migrations,
   secrets/tokens, packaging — see `.claude/rules/security.md`), and ends with a PASS/FAIL verdict.
3. **(Optional) second opinion** — for higher-risk changes, also run the **verifier** agent to
   refute "done" with evidence (it judges *completion*, distinct from the code-review's *quality*).
4. **Write the report** — use the Write tool to create `reports/<feature-slug>-review.md`:

```markdown
# Review: <Feature Name>

## Verdict
PASS / FAIL

## Findings (by severity)
| Severity | File:line | Finding | Suggested fix |
|----------|-----------|---------|---------------|
| CRITICAL | ... | ... | ... |

## Acceptance criteria
- [x] <criterion> — met (evidence)

## Heightened-scrutiny paths
<which were touched and the named human-review note, or "none">
```

**Handoff:** address CRITICAL/HIGH findings, re-run `/verify`, then open the PR and comment
`/claude-review` for the gated AI pass + a human architecture review (two-reviewer minimum).
