---
name: harness-improve
description: >
  Use this skill ONLY when explicitly asked to improve the agentic-SDLC harness itself —
  i.e. capturing a new learning/footgun/incident as a rule, or auditing existing harness
  files for stale/duplicate rules and [REVIEW]→[GATE] promotion candidates. It edits
  CLAUDE.md files, .claude/rules/*, ci/harness-gates.sh, or scaffolds new skills. Do NOT
  load for ordinary feature work, bug fixes, code review, or general coding. Invoke
  explicitly with /harness-improve.
disable-model-invocation: true
---

# /harness-improve — Capture Learnings & Audit the Harness

**Usage:** `/harness-improve [a learning to capture, or "audit"]`

## When to use

**Load this skill only when you are explicitly improving the harness itself** — the system of
guides and sensors that shapes AI-assisted work in this repo (CLAUDE.md files, `.claude/rules/*`,
`ci/harness-gates.sh`, agents, skills, hooks). Two modes:

- **Capture** — you have a *concrete learning* (a bug you paid for, a recurring review comment, a
  language/library footgun) and want it encoded so the team never pays for it again.
- **Audit** — you want a scan of the existing harness for stale/duplicate rules, `[REVIEW]` rules
  ready to become `[GATE]`, unconfigured gates, and documentation gaps.

Do **NOT** load this for ordinary feature work, bug fixing, code review, or general coding. If you
are unsure which mode (or whether this skill applies at all), ask the developer first.

> **This skill proposes before it edits.** The files it touches are loaded by *everyone's* sessions.
> Never edit `CLAUDE.md`, `.claude/rules/*`, or `ci/harness-gates.sh` until the developer has
> approved the exact proposed change.

## The governing principle: the failure-to-rule ratchet

From `docs/ai_harness/AI_Harness_Playbook.md` §6.4:

> *"every line in a good rules file should be traceable to a specific thing that went wrong"* —
> corollary **rule-noise**: *"more rules make each rule matter less."*

So this skill enforces a **ratchet, not a wish-list**:

1. **No rule without a traceable failure.** If the developer can't name the concrete thing that went
   wrong, push back rather than add noise.
2. **Guard against rule-noise.** Before adding anything, check whether an existing rule already
   covers it — refine in place instead of appending a near-duplicate.
3. **Promote `[REVIEW]` → `[GATE]` over time.** A rule a formatter/linter/script can check
   mechanically *today* should be a gate; "follow our standards" is probabilistic, a gate is
   deterministic. Moving rules from review to gate *is the work*.
4. **The ratchet retires, too.** A rule made redundant by a better model or a new gate should be
   removed, not left to rot.

## The harness map (where things live, so you can route correctly)

| Layer | File(s) | Role |
|---|---|---|
| Rules-as-code | `.claude/rules/{security,architecture,conventions}.md` | Tagged `[GATE]`/`[REVIEW]`; guide AI review + compile to gates |
| Always-on context (local) | any nested `CLAUDE.md` (add one when a subsystem's logic is non-obvious) | Per-subsystem behaviour, gotchas, integrations |
| Deterministic gates | `ci/harness-gates.sh` | gates: `format` / `lint` / `typecheck` / `check` (no-arg = `npm run check`); blocking |
| Specialists | `.claude/agents/*.md` | spec-writer, coder, test-author, code-review, verifier, deep-dive, … |
| Progressive skills | `.claude/skills/<name>/SKILL.md` | Task-triggered workflows (`/harness-plan`, `/harness-implement`, `/harness-review`) |
| Hooks | `.claude/settings.json` (+ any `.claude/hooks/*`) | Pre/Post/Stop enforcement |

`[GATE]` = auto-enforced, build fails. `[REVIEW]` = judgement call by the AI + human reviewer.

---

## Mode A — Capture a learning

### Step 1 — Elicit the failure (the ratchet gate)

Get a concrete trace before doing anything else:

- **What** went wrong (the behaviour / footgun / mistake)?
- **Where** (file, PR, incident, supplier)?
- **Evidence** (the failing case, the review comment, the log)?

If there's no traceable failure, say so and stop — don't manufacture a rule.

### Step 2 — Route it

Use this decision guide to pick the home and the format:

| The learning is… | Home | Format |
|---|---|---|
| A language/library footgun (TS/JS, async, Electron/IPC, logging) that applies **repo-wide** | `.claude/rules/conventions.md` (or a root `CLAUDE.md` if you create one) | A tagged rule — add a **BAD / GOOD code pair** when a concrete snippet makes it clearer |
| Behaviour specific to **one subsystem** | the **nearest** nested `CLAUDE.md` (create one under that subsystem if absent) | Purpose / How it works / Gotchas — practical, not exhaustive |
| A **security / architecture / convention standard** | the matching `.claude/rules/*.md` | **one tagged line** that *points at* the detail; don't restate detail that already lives in a `CLAUDE.md` or `code-review.md` |
| **Mechanically checkable today** (a formatter/linter/script can catch it) | a `[GATE]` line in the rules file **and** the enforcing command in `ci/harness-gates.sh` | extend an existing gate (e.g. add an ESLint rule so `lint` catches it) or add a new `case` branch to `run_gate` in `ci/harness-gates.sh` |
| A **repeatable multi-step task pattern** (recurring work-shape) | a **new skill** under `.claude/skills/<name>/SKILL.md` | narrow, anti-trigger-rich `description`; `disable-model-invocation: true` for explicit `/`-only skills |

When the right home is genuinely ambiguous (e.g. could be a root rule or a rules-file `[REVIEW]`),
use `AskUserQuestion` rather than guessing.

### Step 3 — Rule-noise guard

`Grep` the target file(s) for an existing rule on the same topic. If one exists, **refine it in
place** (tighten wording, add the new case) instead of appending a near-duplicate. Report what you
found.

### Step 4 — Tag correctly

- `[GATE]` **only** if it's mechanically enforceable *now*. If you tag `[GATE]`, you must also wire
  or extend the enforcement in `ci/harness-gates.sh` — a `[GATE]` with no gate is a lie.
- Otherwise `[REVIEW]`, and add a one-line note on what would make it promotable later.

### Step 5 — Propose, then edit

Present the proposal (see *Proposal format* below) and apply it **only after approval**.

---

## Mode B — Audit the harness

A read-only scan that produces a findings report. Cover:

1. **Promotion candidates** — `[REVIEW]` rules in `.claude/rules/*` and `CLAUDE.md` that a linter /
   formatter / script could now enforce → recommend `[REVIEW]` → `[GATE]` + the gate wiring.
2. **Rule-noise** — duplicate, overlapping, or contradictory rules across root `CLAUDE.md` and the
   three rules files → recommend consolidation.
3. **Retire candidates** — rules with no traceable failure or made redundant by a gate/newer model.
4. **Coverage gaps** — checks the gate *could* run but doesn't yet: `ci/harness-gates.sh`
   currently wires only `format` / `lint` / `typecheck` / `check`. Candidates to add as a new
   `run_gate` branch: a secrets scan, `npm audit`, or a security lint over the IPC/preload surface.
5. **Doc gaps** — subsystems with non-obvious logic and no nearest `CLAUDE.md` (there are none in
   this repo yet — an IPC-heavy or git/pty subsystem is a good first candidate).

Output a severity-ordered table:

```markdown
| Severity | Finding | Evidence / location | Recommendation | Effort |
|----------|---------|---------------------|----------------|--------|
```

Then offer to action the top items via Mode A's propose-then-edit flow.

---

## Proposal format (both modes)

Before editing, present each change as:

```markdown
### Proposed change
- **Target:** <file path + section/line>
- **Mode:** add | refine-in-place | promote-to-gate | retire
- **Tag:** [GATE] | [REVIEW] | n/a
- **Text:**
  <the verbatim line(s) / code-pair / gate wiring to add or modify>
- **Traces to:** <the concrete failure this prevents>
- **Gate wiring:** <if [GATE]: the CMD_* / GATES change in ci/harness-gates.sh, else "n/a">
```

Apply with Edit/Write **only after the developer confirms**.

## Definition of Done for a harness edit

- Rules files stay **lean** — they index and point at detail, they don't restate it.
- A `[GATE]` tag is matched by real enforcement in `ci/harness-gates.sh`.
- If a root-`CLAUDE.md` behaviour changed, root `CLAUDE.md` is updated (it's the contract).
- New skill scaffolded? Its `description` is narrow and anti-trigger-rich (authoring guidelines).
- Changelog / PR note if the engineering contract changed.
