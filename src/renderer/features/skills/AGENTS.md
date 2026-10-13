# Skills UI

- The Skills tab is an inventory and orchestration surface, not a renderer filesystem client. List
  native skills through the typed `slash:list` channel and keep all workspace access in main.
- Preserve same-name skills at different scopes. Consolidate only matching Claude/Codex copies at
  the same scope so provenance remains visible and workspace overrides do not hide personal skills.
- Search and filters operate only on the sanitized `SlashCommand` catalogue already in renderer
  memory; filtering must not trigger filesystem reads or collapse provider/scope collisions.
- Agent-assisted creation seeds a reviewable prompt into the existing chat composer. The agent
  writes matching `.claude/skills/<slug>/SKILL.md` and `.agents/skills/<slug>/SKILL.md` files so the
  result stays source-controlled and provider-native.
