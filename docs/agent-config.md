# File-configured agents

Harness ships immutable Polly, Debby, and Harness PIV built-ins and supports project-scoped custom
bundles. This is a safe subset of Omnigent configuration, not runtime compatibility.

## Storage and identity

| Kind | Location | Identity | Mutation |
|---|---|---|---|
| Built-in | packaged `resources/builtin-agents/<slug>` | `builtin:<slug>` | immutable; duplicate before editing |
| Project | app-managed `projects/<projectId>/agents/<slug>` | `project:<projectId>:<slug>` | atomic writes; recoverable OS-trash delete |

Slugs contain lowercase letters, digits, and hyphens, are at most 63 characters, and are immutable
in v1. Rename by duplicating then deleting after scheduled references are updated. Imports are
copied into a fresh managed slug; Harness never executes or watches an external directory in place.

## Supported grammar

Each bundle has `config.yaml`; child files are `agents/<slug>/config.yaml` and
`skills/<slug>/SKILL.md`.

```yaml
version: 1
name: Example coordinator
description: Bounded implementation and review
prompt: Delegate the goal and synthesize retained results.
instructions: coordinator.md # relative Markdown file; content is snapshotted
executor:
  harness: claude_code # executor.config.harness is also normalized
  model: sonnet # optional
  mode: plan # plan | default
  read_only: true # independent safety property; required for coordinators
tools:
  agents: [implementer, reviewer]
  skills: [workflow]
requires:
  providers: [claude_code, codex]
policy:
  max_dispatches: 8
  max_parallel: 3
  turn_timeout_ms: 1800000
  run_timeout_ms: 7200000
  max_request_bytes: 65536
  max_result_bytes: 131072
  critique_rounds: 0
```

Child configs use the same root grammar. Their optional `instructions` path is relative to that
child's directory; root instructions are relative to the bundle root. Referenced Markdown content
is confined, validated, and embedded in the normalized snapshot. Unreferenced files or directories
are rejected. `tools.purposes` is a closed subset of `research`, `plan`,
`implement`, `test`, `review`, `verify`, and `critique`; `independent_provider: true` requires a
provider different from the coordinator. Skills are plain Markdown instructions. Duplicate YAML
keys, aliases, multiple documents, unknown keys, excessive depth/count, traversal, symlinks,
special files, and oversized files fail validation. The two executor shapes normalize to one
`{ harness, model?, mode, readOnlyMode }` value; conflicts are rejected. Coordinators must be
read-only. `plan` implies read-only for backward compatibility, while `read_only: true` lets an
adapter enforce inspection-only execution without falsely claiming a provider-native plan mode.

## Normalization and limits

| Item | v1 rule |
|---|---|
| File / bundle | 256 KiB per file / 2 MiB total |
| Dispatch depth | one direct child level |
| Dispatches / parallel | 1–32 / 1–8; parallel never exceeds total |
| Critique rounds | 0–3 |
| Request/result | validated policy plus broker hard limits |
| Revision | SHA-256 of the canonical normalized version-1 snapshot |

Diagnostics include a stable code, message, and optional relative file/line/column. A temporarily
invalid edit never replaces the last valid runnable registry snapshot. Scheduled tasks and runs
store their exact normalized snapshot and digest in main-only SQLite fields; renderer DTOs receive
only identity, name, revision, status, and retained result metadata.

## Execution and security model

Every coordinator and child is an ordinary `HarnessSupervisor` turn in an isolated workspace.
Electron main owns creation, claims, durable state, providers, limits, and cleanup. A private Unix
socket and short-lived token authorize only `dispatch`, `continue_dispatch`, `await_dispatches`, and
`cancel_dispatch`. The stdio proxy has no database, Electron IPC, git, filesystem, generic process,
or merge API. Tokens live in mode-0600 files below a mode-0700 directory, never appear in argv or
renderer state, are redacted from errors, and are revoked on completion, cancel, takeover, recovery,
and shutdown.

Claude enforces read-only execution with its plan permission mode. Codex read-only child roles use
the CLI's `read-only` sandbox with approval escalation disabled; writable Codex roles continue to
use their isolated child worktree. Codex is not eligible as a coordinator because its current
non-interactive CLI cannot combine read-only enforcement with MCP control without disabling the
sandbox. Harness therefore keeps `supportsPlanMode` false and does not advertise a capability the
adapter cannot enforce.

Debby is a fixed protocol rather than a generic dispatch grid: both cross-provider partner answers
must complete before each cross-provider critic runs once per configured round. The round/stage is
stored durably and shown explicitly before coordinator synthesis; incomplete debates fail instead
of being presented as a completed comparison.

Push, PR creation, and merge are never broker capabilities. A user may explicitly record push and
draft-PR consent when starting a run. After successful synthesis, Electron main publishes only
completed child branches with retained changes through the existing reviewed branch-only Git/PR
workflow; PR consent also requires push consent. Publishing failures fail the run, worktrees remain
available for inspection/takeover, and merge authority always stays with the user. Knowledge
remains untrusted reference content and is never interpreted as agent configuration.

## Rejected and future

| Classification | Fields/capabilities |
|---|---|
| Rejected | arbitrary MCP/Python/function/shell/terminal tools; environment injection; broad policies; absolute paths; symlinks; generic IPC/database/git; recursive delegation; auto-merge |
| Future | more coordinator-capable adapters; global/remote registries; cloud execution |

Unsupported executable fields are errors, never silently dropped. `version: 1` is required after
normalization. Future breaking grammar gets a new version; stored scheduled/run snapshots remain
pinned to their recorded version and digest.

Polly and Debby adapt role-graph ideas from the Apache-2.0
[Omnigent Polly](https://github.com/omnigent-ai/omnigent/tree/main/examples/polly) and
[Omnigent Debby](https://github.com/omnigent-ai/omnigent/tree/main/examples/debby) examples.
Harness's configs, bounded broker, supervised workspaces, and PIV agent are newly authored. No
upstream unsandboxed execution settings are copied.
