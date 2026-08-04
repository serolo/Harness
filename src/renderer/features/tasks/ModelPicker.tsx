import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Zap } from 'lucide-react';
import type { HarnessId } from '@shared/harness';
import {
  runtimeProviderModel,
  visibleProviderModelGroups,
} from '../chat/modelCatalog';
import { readModelPreferences } from '../settings/modelPreferences';

export interface ModelPickerValue {
  model: string | null;
  harnessOverride: HarnessId | null;
}

export interface ModelPickerProps extends ModelPickerValue {
  onChange: (value: ModelPickerValue) => void;
}

const DEFAULT_VALUE = '__default__';

/**
 * Scheduled tasks share Chat's provider catalogue, runtime normalization, and
 * button/popover presentation so model selection behaves consistently across surfaces.
 */
export function ModelPicker({
  model,
  harnessOverride,
  onChange,
}: ModelPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 16, top: 16 });
  const groups = visibleProviderModelGroups().filter(
    (group) => group.harness !== undefined,
  );
  const preferences = readModelPreferences();
  const defaultModel = groups
    .flatMap((group) => group.options)
    .find(
      (option) =>
        option.id === preferences.defaultModel ||
        option.model === preferences.defaultModel,
    );
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
  const selected =
    resolved === DEFAULT_VALUE
      ? defaultModel
      : groups
          .flatMap((group) => group.options)
          .find((option) => option.id === resolved);
  const selectedLabel =
    selected?.label ??
    (resolved === DEFAULT_VALUE ? preferences.defaultModel : resolved);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsidePointer(event: PointerEvent): void {
      if (
        event.target instanceof Node &&
        !pickerRef.current?.contains(event.target) &&
        !menuRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () =>
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;

    function positionMenu(): void {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;

      const viewportPadding = 16;
      const gap = 10;
      const viewportHeight = window.innerHeight;
      const menuWidth = Math.min(360, window.innerWidth - viewportPadding * 2);
      const triggerRect = trigger.getBoundingClientRect();
      const menuHeight = Math.min(
        menu.scrollHeight,
        viewportHeight - viewportPadding * 2,
      );
      const aboveTop = triggerRect.top - gap - menuHeight;
      const belowTop = triggerRect.bottom + gap;
      const top =
        aboveTop >= viewportPadding
          ? aboveTop
          : belowTop + menuHeight <= viewportHeight - viewportPadding
            ? belowTop
            : viewportPadding;
      const left = Math.min(
        Math.max(viewportPadding, triggerRect.left),
        window.innerWidth - viewportPadding - menuWidth,
      );
      setMenuPosition({ left, top });
    }

    positionMenu();
    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', positionMenu, true);
    return () => {
      window.removeEventListener('resize', positionMenu);
      window.removeEventListener('scroll', positionMenu, true);
    };
  }, [open]);

  function choose(value: string): void {
    setOpen(false);
    if (value === DEFAULT_VALUE) {
      onChange({ model: null, harnessOverride: null });
      return;
    }
    const option = groups
      .flatMap((group) => group.options)
      .find((candidate) => candidate.id === value);
    if (!option) return;
    onChange({
      model: runtimeProviderModel(option),
      harnessOverride: option.harness ?? harnessOverride,
    });
  }

  return (
    <div className="relative min-w-0 max-w-[20rem]" ref={pickerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="flex h-9 max-w-full min-w-0 items-center gap-2 rounded-2 px-2 text-sm font-medium text-fg-2 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1"
        data-testid="task-model-select"
        aria-label="Select model"
        aria-expanded={open}
        title="Select model"
        onClick={() => setOpen((current) => !current)}
      >
        <Zap className="h-5 w-5 shrink-0 text-fg-3" aria-hidden />
        <span className="min-w-0 truncate whitespace-nowrap">
          {selectedLabel}
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              style={menuPosition}
              className="fixed z-[60] max-h-[calc(100vh-32px)] w-[min(360px,calc(100vw-32px))] overflow-y-auto rounded-4 border border-border-1 bg-surface-panel shadow-4"
              data-testid="task-model-menu"
            >
              <button
                type="button"
                className={`flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-bg-3 ${
                  resolved === DEFAULT_VALUE ? 'bg-bg-3' : ''
                }`}
                data-testid="task-model-option-default"
                onClick={() => choose(DEFAULT_VALUE)}
              >
                <Zap className="h-4 w-4 text-fg-3" aria-hidden />
                <span className="min-w-0 flex-1 text-base font-medium text-fg-1">
                  {defaultModel?.label ?? preferences.defaultModel}
                </span>
                {resolved === DEFAULT_VALUE ? (
                  <Check className="h-4 w-4 text-fg-2" aria-hidden />
                ) : null}
              </button>
              {groups.map((group) => (
                <div key={group.id} className="border-t border-border-1">
                  <div className="flex items-center gap-2 px-4 pb-2 pt-3 text-sm font-medium text-fg-3">
                    <Zap className="h-4 w-4" aria-hidden />
                    <span>{group.label}</span>
                  </div>
                  {group.options.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={`flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-bg-3 ${
                        resolved === option.id ? 'bg-bg-3' : ''
                      }`}
                      data-testid={`task-model-option-${option.id}`}
                      onClick={() => choose(option.id)}
                    >
                      <Zap className="h-4 w-4 text-fg-3" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-base font-medium text-fg-1">
                        {option.label}
                      </span>
                      {resolved === option.id ? (
                        <Check className="h-4 w-4 text-fg-2" aria-hidden />
                      ) : null}
                    </button>
                  ))}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
