// CommandPalette — the ⌘K action palette overlay (Phase 6, Track H2).
//
// A centered overlay with a search input and a fuzzy-filtered command list. It renders
// only when `ui.paletteOpen` is set (the ⌘K menu accelerator toggles that flag via
// AppLayout). Keyboard model, all scoped to the autofocused input so there is no global
// listener to leak: ↑/↓ move the highlight, Enter runs the highlighted command, Esc
// closes. Clicking the backdrop or running a command closes the palette.
//
// Commands come from `useCommands` — the SAME registry AppLayout's menu dispatcher uses —
// so a palette entry and a keyboard shortcut can never diverge. This component owns no
// action logic; it only selects + runs.

import { useEffect, useMemo, useRef, useState } from 'react';

import { useUiStore } from '@renderer/stores/ui';
import { Kbd } from '@renderer/components/ui';
import {
  filterCommands,
  useCommands,
  type CommandActions,
} from './useCommands';

export interface CommandPaletteProps {
  /** Action callbacks bound into the shared command registry (owned by AppLayout). */
  actions: CommandActions;
}

export function CommandPalette({
  actions,
}: CommandPaletteProps): React.JSX.Element | null {
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);
  const { commands } = useCommands(actions);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(
    () => filterCommands(commands, query),
    [commands, query],
  );

  // Reset the query + highlight and focus the input each time the palette opens. The
  // effect runs post-commit, so the input ref is populated by the time we focus it.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      inputRef.current?.focus();
    }
  }, [open]);

  // Keep the highlight in range as the result set shrinks/grows.
  useEffect(() => {
    setActive((a) => (a >= results.length ? 0 : a));
  }, [results.length]);

  if (!open) return null;

  const close = (): void => setOpen(false);

  const runAt = (index: number): void => {
    const command = results[index];
    if (!command) return;
    close();
    command.run();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (results.length === 0 ? 0 : (a + 1) % results.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) =>
        results.length === 0 ? 0 : (a - 1 + results.length) % results.length,
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  return (
    <div
      className="absolute inset-0 z-50 flex animate-[hn-fade_180ms_var(--ease-out)] items-start justify-center bg-scrim backdrop-blur-[8px] pt-[12vh]"
      data-testid="command-palette-overlay"
      onClick={close}
    >
      <div
        className="w-[560px] max-w-[90vw] animate-[hn-rise_280ms_var(--ease-out)] overflow-hidden rounded-4 border border-border-1 bg-surface-overlay shadow-4"
        data-testid="command-palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          className="w-full border-b border-border-1 bg-transparent px-4 py-3 text-sm text-fg-1 placeholder:text-fg-3 focus:outline-none"
          placeholder="Type a command…"
          data-testid="command-palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul className="max-h-[50vh] overflow-y-auto py-1" role="listbox">
          {results.length === 0 ? (
            <li
              className="px-4 py-3 text-xs text-fg-3"
              data-testid="command-palette-empty"
            >
              No matching commands.
            </li>
          ) : (
            results.map((command, idx) => (
              <li
                key={command.id}
                role="option"
                aria-selected={idx === active}
                data-testid={`command-item-${command.id}`}
                data-active={idx === active}
                className={`flex cursor-pointer items-center justify-between gap-3 px-4 py-2 text-sm transition-colors duration-fast ease-out ${
                  idx === active
                    ? 'bg-bg-4 text-fg-1'
                    : 'text-fg-2 hover:bg-bg-3'
                }`}
                onMouseEnter={() => setActive(idx)}
                onClick={() => runAt(idx)}
              >
                <span className="truncate">{command.title}</span>
                {command.subtitle ? (
                  <span className="shrink-0 text-2xs text-fg-3">
                    {command.subtitle}
                  </span>
                ) : null}
              </li>
            ))
          )}
        </ul>
        <div className="flex items-center justify-end gap-3 border-t border-border-1 px-4 py-2 text-2xs text-fg-3">
          <span className="inline-flex items-center gap-1.5">
            <Kbd keys="↑↓" /> Navigate
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd keys="⏎" /> Select
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd keys="⎋" /> Close
          </span>
        </div>
      </div>
    </div>
  );
}
