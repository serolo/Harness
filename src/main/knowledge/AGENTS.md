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
- `index.md` is the deterministic navigation/fallback catalog (path-sorted) and may project
  `description`, `applies_when`, `globs`, `source`, and `links` metadata. Search and page loading
  are bounded enrichments; retrieval failure must not block an agent turn.
- MCP-capable turns receive no page content before the turn. Harness appends its own read-only,
  project-scoped MCP server and a compact search-before-read instruction. The per-turn server
  excludes reserved files, enforces canonical status/path confinement, and cumulatively budgets
  actual serialized search/read responses. Non-MCP turns may preselect at most two pages within
  1,000 estimated tokens and never fall back to `index.md`.
- Post-turn extraction runs through `PostTurnKnowledgeCurator`, a bounded seam. It currently
  preserves the legacy hidden proposal-block protocol. An autonomous provider turn is deferred
  until Harness has a non-recursive ephemeral-turn abstraction; do not run curation through the
  ordinary persisted supervisor lifecycle.
- ZIP imports are secret-scanned and converted to pending proposals. Only proposal acceptance
  may write, lint, catalog, log, stage, and commit canonical files. ZIP inflation is asynchronous
  and output-bounded; normalized paths must be unique. Import normalization adds missing `type`
  and `status` fields independently and never overwrites an explicitly authored status.
- User-triggered catalog refresh repairs only parseable, nonreserved pages with a valid `type` and
  no explicit `status`, making the legacy canonical default durable. It preserves every explicit
  status and every malformed page, then commits repaired pages and the rebuilt index atomically.
  Refresh requires an empty Git index so rollback can preserve preexisting staged work exactly.
- Accepted proposals rebuild `index.md` in the same Git commit. Rejected proposals retain the
  optional reviewer reason in proposal audit state. Proposal operation count and content size are
  bounded at the service boundary, and failed acceptance must restore both files and the Git index.
- A reviewed `create` targeting an existing canonical page is consolidated rather than overwritten:
  preserve canonical frontmatter and existing Markdown, merge proposed content into matching
  sections, and deduplicate identical blocks. Reserved bundle files still conflict.
