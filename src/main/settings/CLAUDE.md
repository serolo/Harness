# src/main/settings — layered TOML settings (read, write, provenance, hot-reload)

**Purpose:** merge the settings layers into one effective object, tell the UI *which layer* supplied
each value, write edits back to the *right* layer, and hot-reload on external edits. Heightened-scrutiny
(`.claude/rules/security.md`): this writes files on user paths and validates untrusted IPC input.

## Layer order (HIGHEST WINS)

    defaults  <  user  <  project-shared  <  project-local

- `defaults` — the zod schema's `.default(...)` values (`schema.ts`). Never a file; never writable.
- `user` — `paths.settingsPath()` (`<userData>/settings.toml`).
- `project-shared` — `<projectDir>/.harness/settings.toml` (committed).
- `project-local` — `<projectDir>/.harness/settings.local.toml` (gitignored).

Later layers deep-merge over earlier ones. **Arrays are ATOMIC** — a higher layer's `mcp` / `scripts.run`
replaces the lower one wholesale (no concat), and provenance for an array is the whole array's source layer.

## The write-per-layer invariant (don't break this)

`write.ts#setSetting` reads the target layer's **raw single-layer** object, sets one key path, validates
the **re-merged effective** result through `EffectiveSettingsSchema`, then serialises **only that layer's
object** back. **Never write the merged blob** — it would flatten provenance and leak higher layers'
values down into a lower file. The key path is guarded against traversal (`..`, empty segments) and
prototype pollution (`__proto__`/`constructor`/`prototype`) *before* any write. A schema violation throws
(a `settings` `AppError`) and writes nothing.

## Read paths: `load()` vs `loadResult()`

- `load()` — **throws** on a malformed layer. Phase-0 contract; startup + tests rely on it.
- `loadResult()` — **non-throwing**. A layer with bad TOML or a zod violation is **skipped** and turned
  into a `SettingsIssue` (`{file, keyPath?, message}`); layers are validated low→high so a broken higher
  layer can never corrupt a good lower one. This is the path the Settings UI + the watcher use.

Both compute provenance via `provenance.ts#effectiveWithProvenance`, which builds provenance **during**
the merge (not a fragile post-pass diff) and then attributes any un-set leaf to `default` by walking the
**validated** value (so unknown/stripped TOML keys never leak into provenance).

## Hot-reload race rule

`watch(cb)` (chokidar, debounced — `watch.ts`) re-merges on file change and emits `settings:changed`.
Handlers read `ctx.settings.get()` **fresh**, so the watcher only refreshes the snapshot + notifies —
it does **not** mutate an in-flight turn. A turn snapshots its settings at `turn:start`; leave that.
The watcher's chokidar handle is torn down in `before-quit` (mirrors the diff watcher).

## The shared contract

The effective shape + `SettingLayer` / `SettingsProvenance` / `SettingsIssue` live in `@shared/settings`
(they cross the IPC boundary via `settings:getEffective|getProvenance|set`). `schema.ts` carries a
compile-time `_AssertEffectiveSettings` guard that fails the build if the zod inferred type ever drifts
from that shared DTO — the shared type stays the single source of truth for the boundary.

## Completion sounds

`notifications.completionSound` is a user-wide selector for a clean chat-turn completion. `none`
disables it; other values map to fixed files under `/System/Library/Sounds`. Playback is independent
of the native notification `enabled` toggle, and the Settings preview IPC accepts only the shared enum.
Never accept a renderer-provided executable or filesystem path for sound playback.
