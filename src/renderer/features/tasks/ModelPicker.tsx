import type { HarnessId } from '@shared/harness';
import { Select } from '@renderer/components/ui';
import {
  runtimeProviderModel,
  visibleProviderModelGroups,
} from '../chat/modelCatalog';

export interface ModelPickerValue {
  model: string | null;
  harnessOverride: HarnessId | null;
}

export interface ModelPickerProps extends ModelPickerValue {
  onChange: (value: ModelPickerValue) => void;
}

const DEFAULT_VALUE = '__default__';

/**
 * Scheduled tasks deliberately share Chat's provider catalogue and runtime model
 * normalization so a selection has identical execution semantics in both surfaces.
 */
export function ModelPicker({
  model,
  harnessOverride,
  onChange,
}: ModelPickerProps): React.JSX.Element {
  const groups = visibleProviderModelGroups().filter(
    (group) => group.harness !== undefined,
  );
  const options = [
    { value: DEFAULT_VALUE, label: 'Workspace default' },
    ...groups.flatMap((group) =>
      group.options.map((option) => ({
        value: option.id,
        label: `${group.label} — ${option.label}`,
      })),
    ),
  ];
  const resolved =
    model === null
      ? DEFAULT_VALUE
      : (groups
          .flatMap((group) => group.options)
          .find(
            (option) =>
              runtimeProviderModel(option) === model &&
              (harnessOverride === null || option.harness === harnessOverride),
          )?.id ?? model);

  return (
    <Select
      options={options}
      value={resolved}
      data-testid="task-model-select"
      onChange={(event) => {
        if (event.target.value === DEFAULT_VALUE) {
          onChange({ model: null, harnessOverride: null });
          return;
        }
        const option = groups
          .flatMap((group) => group.options)
          .find((candidate) => candidate.id === event.target.value);
        if (!option) return;
        onChange({
          model: runtimeProviderModel(option),
          harnessOverride: option.harness ?? harnessOverride,
        });
      }}
    />
  );
}
