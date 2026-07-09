# CLAUDE.md — `src/main/checks` (merge-readiness aggregator)

`ChecksService` rolls six per-workspace signals into one `ChecksResult` (the CANONICAL
shared shape in `@shared/checks`, re-exported here). Blockers gate the Merge button and
drive the panel's one-click next actions. Heightened-scrutiny path: it reads GitHub
(network + tokens) — see `src/main/integrations/CLAUDE.md`.

## Signals → severity → action (the blocker→action map)

| source | blocker/pending condition | `suggestedAction` | panel command |
|---|---|---|---|
| `git` | uncommitted or unpushed work | `Commit & push` | `pr:open` |
| `pr` | no PR exists yet | `Create PR` | `pr:open` |
| `ci` | any failing check-run/status (**blocker**) | `Fix failing checks` | `pr:fixChecks` |
| `review` | unresolved review threads (**blocker**) | `Fix review comments` | `pr:fixReviews` |
| `deployment` | a failed environment (**warning only** — never blocks) | — | — |
| `todos` | open todos (pending) | `Complete: …` (informational) | — |

Only `ci` and `review` produce `blocker` severity. `git`/`pr`/`todos` are `pending`;
`deployment` failures are `warning`. Roll-up `state` = `blocked` if any blocker, else
`pending` if any pending, else `green` (warnings do not change it). The renderer's
`blockerCommandFor(suggestedAction)` mirrors the middle two columns.

## Atomic GitHub-group degrade

`git` (local) and `todos` (DB) always compute. The GitHub-dependent rows —
`pr`/`ci`/`deployment`/`review` — are accumulated into a LOCAL array and merged into the
result **only after the whole group succeeds**. A missing account, a non-github origin, or
ANY client error discards the *partial* group (all-or-nothing) so the panel never shows a
`pr` row with the ci/review rows silently absent. The swallowed error may reference the
origin but never a token; nothing is logged.

## Single-slot cache + `checks:updated`

Per-workspace single-slot cache keyed on a `(headSha, prNumber, signal)` signature (each
item's `source=severity`). `get()` returns the cached result (computing on first access);
`refresh()` recomputes, overwrites the slot, and emits `checks:updated` on every run.
Callers refresh on window focus, after a turn, and after git/PR actions.

## needs_attention on failing CI

`finalize()` fires the best-effort `setNeedsAttention(workspaceId, 'CI failing')` hook
when a `ci` item is a blocker. It is fire-and-forget and must never wedge a refresh
(errors are swallowed).
