// Provenance-aware layered merge (Phase 6, Task A1 / phase doc §8).
//
// Same precedence + merge semantics as the read-only merge in `./index.ts`
// (defaults < user < project-shared < project-local; later layers win; arrays are
// ATOMIC), but it additionally records WHICH layer supplied each effective leaf so
// the Settings UI can render a provenance badge per row.
//
// Provenance is built DURING the merge (phase doc §8 risk — not a fragile post-pass
// diff): as each layer is merged in low→high order, every scalar/array leaf it sets
// stamps its tag over any lower layer's. Leaves that no TOML layer set fall through
// to `default` (the schema's `.default(...)` values) when we walk the validated
// result. Arrays never recurse — the whole array's source layer is the leaf's
// provenance, matching "highest layer replaces the array wholesale".

import { EffectiveSettingsSchema, type EffectiveSettings } from './schema';
import type {
  SettingLayer,
  SettingsProvenance,
  WritableSettingLayer,
} from '@shared/settings';

/** A plain JSON-ish object (the parsed shape of a TOML table). */
type PlainObject = Record<string, unknown>;

/** One on-disk layer + its provenance tag, in the caller's precedence order (low → high). */
export interface TaggedLayer {
  tag: WritableSettingLayer;
  obj: PlainObject;
}

/** Result of {@link effectiveWithProvenance}: the validated value + its per-leaf provenance. */
export interface EffectiveWithProvenance {
  value: EffectiveSettings;
  provenance: SettingsProvenance;
}

/** True for non-null, non-array object values (i.e. mergeable TOML tables). */
function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Prototype-pollution guard: keys that must never be walked/assigned as data. */
function isUnsafeKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

/**
 * Merge one `source` layer onto `target` (mutating `target`), stamping `tag` into
 * `prov` for every scalar/array leaf it sets. Nested tables recurse (so sibling
 * keys from lower layers survive); arrays and scalars replace wholesale and record
 * provenance at their own path. When a higher layer replaces a table with a scalar/
 * array, stale child provenance under that path is cleared.
 */
function mergeLayer(
  target: PlainObject,
  source: PlainObject,
  tag: SettingLayer,
  prov: Record<string, SettingLayer>,
  prefix: string,
): void {
  for (const [key, sourceValue] of Object.entries(source)) {
    if (isUnsafeKey(key)) {
      continue;
    }
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isPlainObject(sourceValue)) {
      // Recurse into a table; leaves inside carry provenance, the table node itself
      // does not. If the lower layer had a non-object here, start a fresh table.
      const existing = target[key];
      const base: PlainObject = isPlainObject(existing) ? existing : {};
      target[key] = base;
      mergeLayer(base, sourceValue, tag, prov, path);
    } else {
      // Scalar or array (atomic): replace + stamp provenance; drop stale children.
      target[key] = sourceValue;
      prov[path] = tag;
      clearChildProvenance(prov, path);
    }
  }
}

/** Remove any provenance entries nested under `path` (a table replaced by a leaf). */
function clearChildProvenance(
  prov: Record<string, SettingLayer>,
  path: string,
): void {
  const childPrefix = `${path}.`;
  for (const key of Object.keys(prov)) {
    if (key.startsWith(childPrefix)) {
      delete prov[key];
    }
  }
}

/**
 * Walk the VALIDATED effective value's leaves (scalars + arrays), assigning each a
 * layer: the raw-merge source if a TOML layer set it, else `default`. Walking the
 * validated value (not the raw merge) means provenance keys exactly match the
 * effective leaves and unknown/stripped TOML keys never leak into provenance.
 */
function collectProvenance(
  value: unknown,
  rawProv: Record<string, SettingLayer>,
  provenance: SettingsProvenance,
  prefix: string,
): void {
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      collectProvenance(child, rawProv, provenance, path);
    }
    return;
  }
  // Scalar or array leaf.
  provenance[prefix] = rawProv[prefix] ?? 'default';
}

/**
 * Deep-merge the given raw layers (low → high) starting from an empty base, then
 * validate/coerce through {@link EffectiveSettingsSchema} (defaults fill every gap),
 * returning the validated value plus per-leaf provenance. Throws on a zod violation,
 * exactly like the read-only `load()` path — callers that must not crash use the
 * non-throwing wrapper in `./index.ts`.
 */
export function effectiveWithProvenance(
  layers: readonly TaggedLayer[],
): EffectiveWithProvenance {
  const merged: PlainObject = {};
  const rawProv: Record<string, SettingLayer> = {};
  for (const { tag, obj } of layers) {
    mergeLayer(merged, obj, tag, rawProv, '');
  }

  const value = EffectiveSettingsSchema.parse(merged);

  const provenance: SettingsProvenance = {};
  collectProvenance(value, rawProv, provenance, '');
  return { value, provenance };
}
