# Harness provider adapters

- Provider CLI flags are versioned contracts, not interchangeable conventions. In particular,
  Codex does not accept Claude's `--mcp-config` or the legacy `--ask-for-approval` flag; use its
  native `-c` configuration overrides and keep a focused argv contract test.
- Codex MCP server commands, arguments, and environment values may contain secrets. Keep them in
  the private `0600` per-turn launch files consumed by `mcp-launcher`; only launcher paths belong
  in provider argv. Clean the containing directory on spawn failure and every terminal path.
- All adapters launch with argument arrays and `shell: false` (or the existing fixed PTY wrapper).
  Never interpolate prompts, workspace data, MCP metadata, or credentials into shell source.
- Every project-backed turn producer must call `TurnPreparationService.prepareTurn`; do not duplicate
  project settings or knowledge injection in IPC, scheduler, or meta-harness code. The supervisor
  owns an accepted knowledge trace, while a producer must call `discard` if start-up fails first.
- `HarnessSupervisor` closes accepted knowledge traces exactly once on every terminal, stream-end,
  stream-error, or start-failure path. It persists detailed sanitized retrieval events followed by
  one turn-level outcome; an MCP configuration being prepared is never evidence that it was used.
- Manual chat turns are keyed by `(workspaceId, contextId)` and may run concurrently across tabs.
  Scheduler/meta turns keep the legacy workspace-exclusive path; workspace status remains `working`
  until the final live context finishes, and context interrupts must never target a sibling tab.
- Claude Code may emit a successful `result` while background `Agent` work is still running and then
  continue the same stream. Treat results as terminal candidates and publish only the latest one when
  the Claude process exits; otherwise the supervisor drops the later plan/output as post-terminal data.
- Every raw agent PTY must carry its `workspaceId` into `PtyService.spawnRaw`, register as an `agent`
  process, and terminate through `treeKillEscalate`. Adapter interrupts must never call node-pty's
  root-only `kill()` directly; force-stop uses the separate immediate tree-wide SIGKILL path.
- Supervisor watchdogs are event-progress based: every non-terminal provider event resets the idle
  limit, while the total limit applies only to plan mode. Snapshot settings at turn start and clear
  both timers on every terminal or startup-failure path.
- Curated model choices must reach the provider as exact runtime IDs. Codex model selections use the
  native `--model` argv pair on both fresh and resumed `exec` turns. Keep the narrow legacy mapping
  for UI-only model IDs already persisted by older scheduled tasks.
