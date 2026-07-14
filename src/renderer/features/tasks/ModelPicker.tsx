// ModelPicker — a model selector for the TaskForm (Phase 12). A `<Select>` offering
// "Default (CLI)" + the `CLAUDE_MODEL_PRESETS` aliases + a "Custom…" escape hatch that
// reveals a free-text input. The value is a `string | null` (`null` = CLI default). The
// custom string is client-side validated against `MODEL_PATTERN` for a friendlier error;
// the IPC boundary re-validates authoritatively.

import { useMemo } from 'react';
import { CLAUDE_MODEL_PRESETS, MODEL_PATTERN } from '@shared/tasks';
import { Select, Input } from '@renderer/components/ui';

/** Sentinel select values distinct from any real model string. */
const DEFAULT_VALUE = '__default__';
const CUSTOM_VALUE = '__custom__';

export interface ModelPickerProps {
  /** The current model, or null for the CLI default. */
  value: string | null;
  onChange: (model: string | null) => void;
}

const PRESET_SET = new Set<string>(CLAUDE_MODEL_PRESETS);

export function ModelPicker({
  value,
  onChange,
}: ModelPickerProps): React.JSX.Element {
  // Which <select> option is active: default (null), a known preset, or Custom.
  const selectValue = useMemo(() => {
    if (value === null) return DEFAULT_VALUE;
    if (PRESET_SET.has(value)) return value;
    return CUSTOM_VALUE;
  }, [value]);

  const isCustom = selectValue === CUSTOM_VALUE;
  const customInvalid =
    isCustom && value !== null && !MODEL_PATTERN.test(value);

  const options = [
    { value: DEFAULT_VALUE, label: 'Default (CLI)' },
    ...CLAUDE_MODEL_PRESETS.map((m) => ({ value: m, label: m })),
    { value: CUSTOM_VALUE, label: 'Custom…' },
  ];

  return (
    <div className="flex flex-col gap-1.5">
      <Select
        options={options}
        value={selectValue}
        data-testid="task-model-select"
        onChange={(e) => {
          const v = e.target.value;
          if (v === DEFAULT_VALUE) onChange(null);
          else if (v === CUSTOM_VALUE)
            onChange(''); // reveal the custom input
          else onChange(v);
        }}
      />
      {isCustom ? (
        <Input
          placeholder="model id (e.g. claude-sonnet-4-5)"
          value={value ?? ''}
          data-testid="task-model-custom"
          aria-invalid={customInvalid}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : null}
      {customInvalid ? (
        <span className="text-2xs text-danger">
          Only letters, digits and . _ : @ - are allowed.
        </span>
      ) : null}
    </div>
  );
}
