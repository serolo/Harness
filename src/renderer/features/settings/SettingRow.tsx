// SettingRow — one editable setting: label + provenance badge + a write-to-layer
// control (Phase 6, Track B). Presentational; the actual write goes through the
// `onSet` callback (wired to `useSettings().set` by the panel). The control kind is
// driven by the field descriptor (`fields.ts`).

import { useEffect, useState } from 'react';

import type { SettingLayer } from '@shared/settings';
import type { FieldDef } from './fields';

/** Short human label + tailwind accent per provenance layer. */
const LAYER_META: Record<SettingLayer, { label: string; className: string }> = {
  default: { label: 'default', className: 'bg-slate-800 text-slate-400' },
  user: { label: 'user', className: 'bg-sky-900/60 text-sky-300' },
  'project-shared': {
    label: 'shared',
    className: 'bg-emerald-900/60 text-emerald-300',
  },
  'project-local': {
    label: 'local',
    className: 'bg-amber-900/60 text-amber-300',
  },
};

export interface SettingRowProps {
  field: FieldDef;
  /** The effective value at this field's key path. */
  value: unknown;
  /** The layer that supplied `value` (undefined → treated as `default`). */
  layer: SettingLayer | undefined;
  /** Persist a new value for this field's key path. */
  onSet: (keyPath: string, value: unknown) => void;
}

/** A small pill showing which layer the effective value came from. */
function ProvenanceBadge({
  layer,
}: {
  layer: SettingLayer;
}): React.JSX.Element {
  const meta = LAYER_META[layer];
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${meta.className}`}
      data-testid="provenance-badge"
      data-layer={layer}
    >
      {meta.label}
    </span>
  );
}

export function SettingRow({
  field,
  value,
  layer,
  onSet,
}: SettingRowProps): React.JSX.Element {
  const effectiveLayer: SettingLayer = layer ?? 'default';

  return (
    <div
      className="flex items-center gap-3 px-3 py-2"
      data-testid={`setting-row-${field.keyPath}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm text-slate-200">{field.label}</span>
          <ProvenanceBadge layer={effectiveLayer} />
        </div>
        {field.hint ? (
          <div className="text-[11px] text-slate-500">{field.hint}</div>
        ) : null}
      </div>
      <div className="shrink-0">
        <FieldControl field={field} value={value} onSet={onSet} />
      </div>
    </div>
  );
}

/** The input/select/checkbox for a field, dispatched on `field.kind`. */
function FieldControl({
  field,
  value,
  onSet,
}: {
  field: FieldDef;
  value: unknown;
  onSet: (keyPath: string, value: unknown) => void;
}): React.JSX.Element {
  const testId = `setting-input-${field.keyPath}`;

  if (field.kind === 'boolean') {
    return (
      <input
        type="checkbox"
        className="h-4 w-4 accent-sky-500"
        data-testid={testId}
        checked={value === true}
        onChange={(e) => onSet(field.keyPath, e.target.checked)}
      />
    );
  }

  if (field.kind === 'select') {
    return (
      <select
        className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200"
        data-testid={testId}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onSet(field.keyPath, e.target.value)}
      >
        {(field.options ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }

  return (
    <TextControl
      testId={testId}
      value={typeof value === 'string' ? value : ''}
      onCommit={(v) => onSet(field.keyPath, v)}
    />
  );
}

/**
 * A text input that commits on blur / Enter (not per keystroke) so a write isn't fired
 * for every character. Local state tracks the in-progress edit; the committed value
 * re-syncs from props when the effective value changes underneath (hot-reload).
 */
function TextControl({
  testId,
  value,
  onCommit,
}: {
  testId: string;
  value: string;
  onCommit: (value: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = (): void => {
    if (draft !== value) onCommit(draft);
  };

  return (
    <input
      type="text"
      className="w-40 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200"
      data-testid={testId}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        }
      }}
    />
  );
}
