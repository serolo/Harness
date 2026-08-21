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
