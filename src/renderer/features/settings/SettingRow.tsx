// SettingRow — one editable setting: label + provenance badge + a write-to-layer
// control (Phase 6, Track B). Presentational; the actual write goes through the
// `onSet` callback (wired to `useSettings().set` by the panel). The control kind is
// driven by the field descriptor (`fields.ts`).

import { useEffect, useState } from 'react';

import type { SettingLayer } from '@shared/settings';
import { Badge, Input, Select, Switch } from '@renderer/components/ui';
import type { BadgeTone } from '@renderer/components/ui';
import type { FieldDef } from './fields';

/** Short human label + Badge tone per provenance layer. */
const LAYER_META: Record<SettingLayer, { label: string; tone: BadgeTone }> = {
  default: { label: 'default', tone: 'neutral' },
  user: { label: 'user', tone: 'accent' },
  'project-shared': { label: 'shared', tone: 'ok' },
  'project-local': { label: 'local', tone: 'warn' },
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
    <Badge
      tone={meta.tone}
      className="shrink-0"
      data-testid="provenance-badge"
      data-layer={layer}
    >
      {meta.label}
    </Badge>
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
      className="grid min-h-[92px] grid-cols-[minmax(0,1fr)_240px] items-center gap-8 py-5"
      data-testid={`setting-row-${field.keyPath}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-base font-semibold text-fg-1">
            {field.label}
          </span>
          <ProvenanceBadge layer={effectiveLayer} />
        </div>
        {field.hint ? (
          <div className="mt-1 text-sm leading-relaxed text-fg-2">
            {field.hint}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 justify-end">
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
      <Switch
        checked={value === true}
        onChange={(checked) => onSet(field.keyPath, checked)}
        data-testid={testId}
      />
    );
  }

  if (field.kind === 'select') {
    return (
      <Select
        options={(field.options ?? []).map((opt) => ({
          value: opt,
          label: field.optionLabels?.[opt] ?? opt,
        }))}
        className="w-full"
        data-testid={testId}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onSet(field.keyPath, e.target.value)}
      />
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
    <Input
      type="text"
      className="w-full"
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
