# Project knowledge subsystem

- Agent-memory discovery is read-only and project-scoped. Repository paths come from
  `ProjectsRepo`, never from renderer input.
- Provider-managed memory is read only from a directory the user explicitly selects in
  the native folder picker. Never infer ownership from a provider's collision-prone
  encoded project-directory name or broadly scan the user's home directory.
- Discovery returns opaque, short-lived source IDs and sanitized display paths. Re-read,
  re-confine, size-check, binary-check, and secret-scan every selected source when creating
  a proposal.
- Agent memory always enters the wiki through a pending `WikiProposal`. Never write it
  directly to `knowledgeDir`, stage it, commit it, or automatically accept it.
- Never log imported content, secret matches, absolute home paths, or proposal operations.

## Architecture and lifecycle

- Canonical knowledge is a local, app-managed Git repository. `storage = "github"` is
  explicitly unsupported until a remote-storage implementation exists; never silently
  reinterpret it as local storage.
- `index.md` is the catalog and retrieval starts there. Catalog generation is deterministic
  (path-sorted) and may project `description`, `applies_when`, `globs`, `source`, and `links`
  metadata. Search and page loading are bounded enrichments; retrieval failure must not block
  an agent turn.
- Post-turn extraction runs through `PostTurnKnowledgeCurator`, a bounded seam. It currently
  preserves the legacy hidden proposal-block protocol. An autonomous provider turn is deferred
  until Harness has a non-recursive ephemeral-turn abstraction; do not run curation through the
  ordinary persisted supervisor lifecycle.
- ZIP imports are secret-scanned and converted to pending proposals. Only proposal acceptance
  may write, lint, catalog, log, stage, and commit canonical files. ZIP inflation is asynchronous
  and output-bounded; normalized paths must be unique.
- Accepted proposals rebuild `index.md` in the same Git commit. Rejected proposals retain the
  optional reviewer reason in proposal audit state. Proposal operation count and content size are
  bounded at the service boundary, and failed acceptance must restore both files and the Git index.
