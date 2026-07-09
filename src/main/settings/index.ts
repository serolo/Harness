// Layered settings service — spec §5.7, README §6.5.
//
// Merges TOML layers in precedence order (HIGHEST WINS):
//
//     defaults  <  user  <  project shared  <  project local
//
//   1. Built-in defaults        (the zod schema's `.default(...)` values)
//   2. User          `paths.settingsPath()`                    (~/.../settings.toml)
//   3. Project shared `<projectDir>/.harness/settings.toml`   (committed)
//   4. Project local  `<projectDir>/.harness/settings.local.toml` (gitignored)
//
// Later layers deep-merge OVER earlier ones; the merged result is then validated
// / coerced through `EffectiveSettingsSchema` so defaults fill any gaps.
//
// The MANAGED layer (`/Library/Application Support/<app>/managed.toml`, spec §5.7
// item 1) is reserved for v2 and is intentionally NOT implemented here.
//
// Phase 6 adds, on top of the Phase-0 read-only merge:
//   - PROVENANCE — which layer supplied each effective leaf (`./provenance.ts`).
//   - a WRITE path — `set(layer, keyPath, value)` persists to one layer's file
//     (`./write.ts`), never the merged blob.
//   - VALIDATION SURFACING — `loadResult()` skips bad layers + returns structured
//     issues instead of throwing (the UI/watcher path). `load()` keeps its
//     throw-on-malformed contract (Phase-0 callers + tests rely on it).
//   - HOT-RELOAD — `watch(cb)` re-merges on file change (`./watch.ts`).

import type { EffectiveSettings } from './schema';
import { EffectiveSettingsSchema } from './schema';
import type {
  SettingsIssue,
  SettingsProvenance,
  WritableSettingLayer,
} from '@shared/settings';
import { effectiveWithProvenance, type TaggedLayer } from './provenance';
import {
  layerFiles,
  readLayersSafe,
  readLayersStrict,
  setSetting,
} from './write';
import { createSettingsWatcher, type SettingsWatcher } from './watch';

/**
 * Overridable file locations for the merge, in precedence order (low → high).
 *
 * TEST SEAM (Task 10): the merge is exercised against temp files by injecting an
 * explicit `userPath` and/or `projectDir` into {@link SettingsService.load}. The
 * user layer additionally honors the `paths` module's own seam
 * (`setUserDataRoot()` / `AGENTAPP_USER_DATA`) when `userPath` is omitted, so a
 * test can drive the merge through either mechanism. Any layer whose file is
 * absent (ENOENT) is silently skipped, so a test can supply 0, 1, or 2 files.
 */
export interface LoadOptions {
  /**
   * Explicit user-level settings file. When omitted, falls back to
   * `paths.settingsPath()` (which respects the paths module's test seam).
   */
  userPath?: string;
  /**
   * Project root. When provided, `<projectDir>/.harness/settings.toml` and
   * `settings.local.toml` are layered on top of the user layer. When omitted,
   * only defaults + user are merged.
   */
  projectDir?: string;
}

/**
 * Non-throwing load outcome (the UI + hot-reload path). Carries the merged value,
 * its provenance, and any per-file/per-key validation issues from layers that were
 * SKIPPED rather than allowed to crash the load.
 */
export interface LoadResult {
  settings: EffectiveSettings;
  provenance: SettingsProvenance;
  issues: SettingsIssue[];
}

/** Callback invoked by {@link SettingsService.watch} on each valid hot-reload. */
export type SettingsChangeListener = (result: LoadResult) => void;

/**
 * Accessor for the effective (merged) settings, with a Phase-6 write path,
 * provenance, and hot-reload.
 *
 * Construct once at app startup, call {@link load} (optionally per active project),
 * then read the immutable snapshot via {@link get}. Writes go through {@link set}
 * (one layer's file) and {@link watch} refreshes the snapshot on external edits.
 */
export class SettingsService {
  /** The current merged + validated snapshot. Never handed out by reference. */
  private snapshot: EffectiveSettings = EffectiveSettingsSchema.parse({});
  /** Per-leaf provenance for {@link snapshot}. */
  private provenanceSnapshot: SettingsProvenance = {};
  /** Validation issues from the most recent {@link loadResult} (empty after `load`). */
  private issuesSnapshot: SettingsIssue[] = [];
  /** The options the snapshot was last loaded with (drives `set`/`watch` file paths). */
  private lastOptions: LoadOptions = {};
  /** The live hot-reload watcher, if {@link watch} is active. */
  private watcher: SettingsWatcher | undefined;

  /**
   * Load and merge the settings layers, replacing the current snapshot.
   *
   * Precedence (highest wins): defaults → user → project shared → project local.
   * Absent files are skipped. THROWS on a malformed layer (Phase-0 contract — tests
   * and the read-only callers rely on this); the resilient path is {@link loadResult}.
   *
   * @param options optional per-project directory + user-path override (test seam)
   */
  load(options: LoadOptions = {}): void {
    this.lastOptions = options;
    const layers = readLayersStrict(options);
    const { value, provenance } = effectiveWithProvenance(layers);
    this.snapshot = value;
    this.provenanceSnapshot = provenance;
    this.issuesSnapshot = [];
  }

  /**
   * Load NON-destructively: a layer whose TOML/zod is invalid is SKIPPED and turned
   * into a {@link SettingsIssue} rather than crashing the load (phase doc §3.1). Bad
   * layers are dropped low→high so a broken higher layer can never corrupt a good
   * lower one. Updates the snapshot and returns the full result.
   */
  loadResult(options: LoadOptions = {}): LoadResult {
    this.lastOptions = options;
    const { layers, issues } = readLayersSafe(options);

    // Validate incrementally so a single bad layer is dropped (with an attributed
    // issue) instead of failing the whole merge. n ≤ 3, so O(n²) is fine.
    const valid: TaggedLayer[] = [];
    for (const layer of layers) {
      try {
        effectiveWithProvenance([...valid, layer]);
        valid.push(layer);
      } catch (err) {
        issues.push(...zodIssuesForLayer(layer, options, err));
      }
    }

    const { value, provenance } = effectiveWithProvenance(valid);
    this.snapshot = value;
    this.provenanceSnapshot = provenance;
    this.issuesSnapshot = issues;
    return { settings: value, provenance, issues };
  }

  /**
   * Return a DEEP CLONE of the current settings snapshot. Callers must never be
   * able to mutate the shared internal state, so every read hands back a copy.
   */
  get(): EffectiveSettings {
    return structuredClone(this.snapshot);
  }

  /** Deep clone of the current per-leaf provenance (which layer supplied each value). */
  getProvenance(): SettingsProvenance {
    return structuredClone(this.provenanceSnapshot);
  }

  /** The validation issues from the most recent {@link loadResult} (empty after `load`). */
  getIssues(): SettingsIssue[] {
    return structuredClone(this.issuesSnapshot);
  }

  /**
   * Persist one setting into a single layer's file, then re-load the snapshot from
   * disk and return the new effective settings. The write validates the re-merged
   * result and writes ONLY the target layer's object (`./write.ts`).
   */
  set(
    layer: WritableSettingLayer,
    keyPath: string,
    value: unknown,
  ): EffectiveSettings {
    setSetting({
      layer,
      keyPath,
      value,
      userPath: this.lastOptions.userPath,
      projectDir: this.lastOptions.projectDir,
    });
    this.loadResult(this.lastOptions);
    return this.get();
  }

  /**
   * Start hot-reloading: watch the current layer files and, on each valid change,
   * refresh the snapshot and invoke `listener` with the new result. Calling `watch`
   * again replaces the previous watcher. Stop via {@link stopWatching}.
   */
  watch(listener: SettingsChangeListener): void {
    this.stopWatching();
    const files = layerFiles(this.lastOptions).map((l) => l.file);
    this.watcher = createSettingsWatcher(files, () => {
      const result = this.loadResult(this.lastOptions);
      listener(result);
    });
  }

  /** Stop the hot-reload watcher (quit teardown). Safe to call when not watching. */
  stopWatching(): void {
    if (this.watcher !== undefined) {
      void this.watcher.close();
      this.watcher = undefined;
    }
  }
}

/**
 * Map a zod validation failure for one skipped layer into `SettingsIssue`s pointing
 * at that layer's file and (best-effort) the offending key path. A non-zod error is
 * surfaced as a single file-level issue.
 */
function zodIssuesForLayer(
  layer: TaggedLayer,
  options: LoadOptions,
  err: unknown,
): SettingsIssue[] {
  const file = fileForTag(layer.tag, options);
  if (err !== null && typeof err === 'object' && 'issues' in err) {
    const zodIssues = (
      err as { issues: { path: (string | number)[]; message: string }[] }
    ).issues;
    return zodIssues.map((i) => ({
      file,
      keyPath: i.path.join('.'),
      message: i.message,
    }));
  }
  return [{ file, message: err instanceof Error ? err.message : String(err) }];
}

/** Resolve the on-disk file for a layer tag under the given load options. */
function fileForTag(tag: WritableSettingLayer, options: LoadOptions): string {
  const match = layerFiles(options).find((l) => l.tag === tag);
  return match?.file ?? tag;
}
