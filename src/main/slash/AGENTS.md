# Native slash catalogue

- Provider-native discovery must mirror each provider rather than inventing one shared convention.
  Claude commands/skills remain under `.claude` and use `/name`; Codex skills come from
  `.agents/skills` along the working-directory-to-repository-root chain, `$HOME/.agents/skills`,
  and `/etc/codex/skills`, and use `$name` for explicit invocation.
- Never expose absolute native-skill paths to the renderer. `SlashCommand` carries only bounded
  provider/source/scope provenance labels.
- Preserve same-name entries from different sources and scopes. The composer must show provenance
  and retain the exact selected entry so a configured prompt cannot silently hide or impersonate a
  provider skill.
- Keep the duplicated `.agents/skills` and `.claude/skills` Harness workflow catalogues in name
  parity; provider-specific instruction and invocation differences are intentional.
