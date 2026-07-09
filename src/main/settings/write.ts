// Settings on-disk layer I/O + the write-to-layer path (Phase 6, Task A3 /
// phase doc §3.1 — heightened-scrutiny: fs writes on user paths).
//
// This module owns everything that touches a settings FILE: resolving each layer's
// path, reading + parsing the raw single-layer TOML, and the write path. The merge
// itself is pure and lives in `./provenance.ts`; the service in `./index.ts` wires
// them together.
//
// WRITE INVARIANT (the load-bearing one): `setSetting` reads the target layer's raw
// single-layer object, sets one key path in it, VALIDATES the re-merged effective
// result, then serialises ONLY that layer's object back. It never writes the merged
// blob — doing so would flatten provenance and leak higher layers' values down into a
// lower file. Traversal / prototype-pollution in the key path is rejected before any
// write.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { AppError } from '@shared/errors';
import type { SettingsIssue, WritableSettingLayer } from '@shared/settings';

import { settingsPath } from '../paths';
import { effectiveWithProvenance, type TaggedLayer } from './provenance';

/** Directory (relative to a project root) holding the project settings layers. */
export const PROJECT_SETTINGS_DIR = '.harness';
/** Committed, shared project settings file. */
export const PROJECT_SHARED_FILE = 'settings.toml';
/** Gitignored, per-developer project override file. */
export const PROJECT_LOCAL_FILE = 'settings.local.toml';

/** A plain JSON-ish object (the parsed shape of a TOML table). */
type PlainObject = Record<string, unknown>;

/** Where each layer's file lives + which project dir (if any) it needs. */
export interface LayerLocation {
  /** Explicit user-file override (test seam); falls back to `settingsPath()`. */
  userPath?: string;
  /** Project root, required for the two project layers. */
  projectDir?: string;
}

/** True for non-null, non-array object values (mergeable TOML tables). */
function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Prototype-pollution guard for a key-path segment. */
function isUnsafeKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

/** Narrow an unknown thrown value to a Node "file not found" error. */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Resolve the absolute file for one writable layer. Project layers require a
 * `projectDir`; asking for one without it is an `invalid_input` AppError (the caller
 * — e.g. `settings:set` for a project layer with no active project — must not write).
 */
export function resolveLayerFile(
  layer: WritableSettingLayer,
  loc: LayerLocation,
): string {
  switch (layer) {
    case 'user':
      return loc.userPath ?? settingsPath();
    case 'project-shared':
      return join(
        requireProjectDir(loc),
        PROJECT_SETTINGS_DIR,
        PROJECT_SHARED_FILE,
      );
    case 'project-local':
      return join(
        requireProjectDir(loc),
        PROJECT_SETTINGS_DIR,
        PROJECT_LOCAL_FILE,
      );
  }
}

function requireProjectDir(loc: LayerLocation): string {
  if (loc.projectDir === undefined) {
    throw new AppError(
      'invalid_input',
      'Writing a project settings layer requires an active project.',
    );
  }
  return loc.projectDir;
}

/**
 * The ordered layer files (low → high) for reading/watching. The user layer is
 * always present; the two project layers are added only when a `projectDir` is
 * given. Absent files are the caller's concern (skipped on read, watched-for-create).
 */
export function layerFiles(loc: LayerLocation): {
  tag: WritableSettingLayer;
  file: string;
}[] {
  const files: { tag: WritableSettingLayer; file: string }[] = [
    { tag: 'user', file: loc.userPath ?? settingsPath() },
  ];
  if (loc.projectDir !== undefined) {
    files.push({
      tag: 'project-shared',
      file: join(loc.projectDir, PROJECT_SETTINGS_DIR, PROJECT_SHARED_FILE),
    });
    files.push({
      tag: 'project-local',
      file: join(loc.projectDir, PROJECT_SETTINGS_DIR, PROJECT_LOCAL_FILE),
    });
  }
  return files;
}

/**
 * Read + parse one raw single-layer TOML file. Returns `undefined` for an absent
 * file (ENOENT → skip the layer). A genuine read/parse error (malformed TOML,
 * permissions) propagates — the STRICT path (`load()`) surfaces it as a throw.
 */
function readLayerStrict(file: string): PlainObject | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
  return parseToml(raw) as PlainObject;
}

/**
 * Build the ordered {@link TaggedLayer} list from disk, THROWING on a malformed
 * layer (mirrors the read-only `load()` contract). Absent files are skipped.
 */
export function readLayersStrict(loc: LayerLocation): TaggedLayer[] {
  const layers: TaggedLayer[] = [];
  for (const { tag, file } of layerFiles(loc)) {
    const obj = readLayerStrict(file);
    if (obj !== undefined) layers.push({ tag, obj });
  }
  return layers;
}

/**
 * Build the ordered {@link TaggedLayer} list from disk NON-destructively: a layer
 * whose TOML fails to parse is turned into a {@link SettingsIssue} and SKIPPED rather
 * than throwing, so one bad file never crashes the load (phase doc §3.1). Absent
 * files are silently skipped (not an issue).
 */
export function readLayersSafe(loc: LayerLocation): {
  layers: TaggedLayer[];
  issues: SettingsIssue[];
} {
  const layers: TaggedLayer[] = [];
  const issues: SettingsIssue[] = [];
  for (const { tag, file } of layerFiles(loc)) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      if (isEnoent(err)) continue; // absent → skip, not an issue
      issues.push({
        file,
        message: `Could not read settings file: ${String(err)}`,
      });
      continue;
    }
    try {
      layers.push({ tag, obj: parseToml(raw) as PlainObject });
    } catch (err) {
      issues.push({
        file,
        message: `Invalid TOML: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return { layers, issues };
}

/** Split + validate a dotted key path, rejecting empty / traversal / unsafe segments. */
function parseKeyPath(keyPath: string): string[] {
  const segments = keyPath.split('.');
  if (segments.length === 0 || segments.some((s) => s === '')) {
    throw new AppError(
      'invalid_input',
      `Malformed settings key path: "${keyPath}"`,
    );
  }
  for (const segment of segments) {
    if (segment === '..' || isUnsafeKey(segment)) {
      throw new AppError(
        'invalid_input',
        `Illegal settings key-path segment: "${segment}"`,
      );
    }
  }
  return segments;
}

/** Set `value` at the dotted path in `obj`, creating intermediate tables. */
function setAtPath(obj: PlainObject, segments: string[], value: unknown): void {
  let cursor = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i]!;
    const next = cursor[key];
    if (!isPlainObject(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as PlainObject;
  }
  cursor[segments[segments.length - 1]!] = value;
}

/** Options for {@link setSetting}. */
export interface SetSettingOptions extends LayerLocation {
  /** Which writable layer's file to persist into. */
  layer: WritableSettingLayer;
  /** Dotted key path within the settings object (e.g. `git.branchPrefix`). */
  keyPath: string;
  /** The new value (already narrowed by the IPC handler). */
  value: unknown;
}

/**
 * Persist one setting into a single layer's TOML file. Reads that layer's raw
 * object (or `{}`), sets the key path, validates the RE-MERGED effective result
 * (throws a `settings` AppError if the new value violates the schema — nothing is
 * written in that case), then serialises ONLY that layer's object back.
 */
export function setSetting(opts: SetSettingOptions): void {
  const { layer, keyPath, value } = opts;
  const segments = parseKeyPath(keyPath);
  const file = resolveLayerFile(layer, opts);

  // Read just this layer (or start empty) and set the value in it.
  const current = readLayerStrict(file) ?? {};
  setAtPath(current, segments, value);

  // Validate the FULL re-merged effective result: rebuild the layer list from disk
  // with this layer's object replaced by the edited one, then run it through the
  // schema. A violation throws before anything is written.
  const merged = readLayersStrict(opts).map((l) =>
    l.tag === layer ? { tag: layer, obj: current } : l,
  );
  if (!merged.some((l) => l.tag === layer)) {
    // The target file was absent, so it wasn't in the disk list — append it.
    merged.push({ tag: layer, obj: current });
  }
  try {
    effectiveWithProvenance(merged);
  } catch (err) {
    throw new AppError(
      'settings',
      `Setting ${keyPath} to that value is invalid: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { keyPath, layer },
    );
  }

  // Write ONLY this layer's object back (never the merged blob).
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, stringifyToml(current), 'utf8');
}
