# Meta-harness subsystem

- Electron main owns all authority. The stdio MCP process is transport-only.
- Tokens are run-scoped, short-lived, stored mode 0600, never logged or exposed to renderer.
- Broker methods are a closed union; validate byte/count/run/role/provider/ownership limits before allocation.
- Only one child delegation depth is supported. Workspaces stay retained after terminal cleanup.
- Cleanup is idempotent and revokes the socket/token before interrupting provider processes.
- Coordinator execution is always read-only and requires an adapter that can preserve MCP control
  without disabling that boundary. Child `readOnlyMode` is independent of provider plan mode.
- Every coordinator and child turn goes through `TurnPreparationService`. Coordinator knowledge is
  intentionally disabled so `harness-meta-control` remains its exclusive MCP authority; eligible
  children receive project knowledge under the same provider-aware policy as ordinary turns.
- Writable children require provider-enforced workspace-scoped execution. Never use a generic
  permission/sandbox bypass for a meta child; reject adapters that cannot prove this capability.
- Supervisor admission is the definitive workspace-claim boundary; prechecks in IPC/scheduler are
  advisory only. Meta turns carry an internal run proof that must match the live claim.
- Deadline callbacks terminalize/interrupt before waiting for the run lock, and every async startup
  rechecks durable state so a late provider cannot escape a timeout.
- Debby is selected by the normalized `protocol: debby` identity (never mutable slug/name), requires
  two completed partner responses followed by both critics exactly once per round, and stores
  stage/round metadata durably for the renderer.
- Push/draft-PR consent is persisted at run start. Successful runs publish only completed changed
  child branches through `PrWorkflow`; publishing is outside broker authority and merge is absent.
  Every publish receives the run-owned abort signal. Deadline, cancel, takeover, and shutdown abort
  Git subprocesses, GitHub requests, and rate-limit waits before waiting for the per-run lock.
- Skill evidence has two distinct meanings. `meta_skill_access` is deterministic access proof: it
  records the exact slug/content digest injected from the immutable run snapshot. A validated final
  `Skills consulted:` footer is only agent-reported usage, must match an offered full SHA-256, and
  must never be described as proof that the model cognitively followed the skill. Keep the footer in
  the transcript for auditability, but strip it from human-facing run summaries after validation.
