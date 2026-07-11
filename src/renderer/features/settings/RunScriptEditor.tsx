// RunScriptEditor — the array-valued settings the scalar `SettingRow` catalogue can't
// express (Phase 6, Track B2). Three editors, one panel section:
//
//   - `[scripts].run`   — named run scripts (name/command/label/icon) + `run_mode`.
//     A saved entry becomes a Phase-3 run button after the hot-reload refresh.
//   - `[env]`           — extra environment variables (key → value).
//   - `[mcp]`           — MCP servers passed to the agent CLI (name/command/args).
//
// ARRAYS ARE ATOMIC in the layered merge (`src/main/settings/CLAUDE.md`): a write must
// replace the WHOLE array/record, never a single element — otherwise provenance flattens
// and a higher layer's values leak into a lower file. So every editor keeps a local draft
// (seeded from the effective value, re-synced on hot-reload) and commits the ENTIRE
// collection through `onSet(keyPath, wholeValue)` on blur / add / remove. Writes target
// the user layer via `useSettings().set` (wired by the panel), same as `SettingRow`.

import { useEffect, useState } from 'react';

import type {
  EffectiveSettings,
  NamedScript,
  SettingLayer,
  SettingsProvenance,
} from '@shared/settings';
import type { McpServerConfig } from '@shared/harness';
import { Badge, Button, Input, Select } from '@renderer/components/ui';
import type { BadgeTone } from '@renderer/components/ui';

export interface RunScriptEditorProps {
  /** The effective (merged) settings — source of the array/record initial values. */
  effective: EffectiveSettings;
  /** Per-leaf provenance (badges which layer supplied each array). */
  provenance: SettingsProvenance;
  /** Persist a whole array/record at a dotted key path (writes the user layer). */
  onSet: (keyPath: string, value: unknown) => void;
}

/** Short label + Badge tone per provenance layer (mirrors SettingRow's badge vocabulary). */
const LAYER_META: Record<SettingLayer, { label: string; tone: BadgeTone }> = {
  default: { label: 'default', tone: 'neutral' },
  user: { label: 'user', tone: 'accent' },
  'project-shared': { label: 'shared', tone: 'ok' },
  'project-local': { label: 'local', tone: 'warn' },
};

/** A small provenance pill for an array/record leaf. */
function ArrayBadge({
  layer,
}: {
  layer: SettingLayer | undefined;
}): React.JSX.Element {
  const meta = LAYER_META[layer ?? 'default'];
  return (
    <Badge
      tone={meta.tone}
      className="shrink-0"
      data-testid="array-provenance-badge"
      data-layer={layer ?? 'default'}
    >
      {meta.label}
    </Badge>
  );
}

/** A compact, monospace text input used across the array editors (shell commands, env
 *  keys, MCP invocations) — commits via `onChange`. Single-line: Enter blurs (commits)
 *  rather than inserting a newline, so this stays an `Input`, not a `Textarea`. */
function Cell({
  testId,
  value,
  placeholder,
  onChange,
  onBlur,
}: {
  testId: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onBlur: () => void;
}): React.JSX.Element {
  return (
    <Input
      type="text"
      mono
      className="min-w-0 flex-1 placeholder:text-fg-3"
      data-testid={testId}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

export function RunScriptEditor({
  effective,
  provenance,
  onSet,
}: RunScriptEditorProps): React.JSX.Element {
  return (
    <section data-testid="run-script-editor">
      <h3 className="px-3 pb-1 pt-3 text-xs font-medium uppercase tracking-caps text-fg-3">
        Scripts &amp; environment
      </h3>
      {/* Tolerate a partial effective object (like the panel's `getAtPath`): every leaf
          falls back to its empty default so a gap never hard-crashes the editor. */}
      <div className="flex flex-col gap-3 px-3 pb-2">
        <ScriptsEditor
          run={effective.scripts?.run ?? []}
          runMode={effective.scripts?.run_mode ?? 'single'}
          layer={provenance['scripts.run']}
          onSetRun={(next) => onSet('scripts.run', next)}
          onSetMode={(mode) => onSet('scripts.run_mode', mode)}
        />
        <EnvEditor
          env={effective.env ?? {}}
          layer={provenance['env']}
          onSet={(next) => onSet('env', next)}
        />
        <McpEditor
          mcp={effective.mcp ?? []}
          layer={provenance['mcp']}
          onSet={(next) => onSet('mcp', next)}
        />
      </div>
    </section>
  );
}

// --- [scripts].run -----------------------------------------------------------

function ScriptsEditor({
  run,
  runMode,
  layer,
  onSetRun,
  onSetMode,
}: {
  run: NamedScript[];
  runMode: 'concurrent' | 'single';
  layer: SettingLayer | undefined;
  onSetRun: (next: NamedScript[]) => void;
  onSetMode: (mode: 'concurrent' | 'single') => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<NamedScript[]>(run);
  // Re-sync from props when the effective array changes underneath (hot-reload / our own
  // committed write echoing back). Keyed on a stable signature so an in-progress edit that
  // hasn't been committed yet is not clobbered by an unrelated re-render.
  useEffect(() => setDraft(run), [signatureOf(run)]);

  /** Write the WHOLE array (atomic) and keep the local draft in step. */
  const commit = (next: NamedScript[]): void => {
    setDraft(next);
    onSetRun(next);
  };

  const patch = (idx: number, key: keyof NamedScript, value: string): void => {
    setDraft((cur) =>
      cur.map((s, i) => (i === idx ? { ...s, [key]: value } : s)),
    );
  };

  return (
    <div data-testid="scripts-run-editor">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-medium text-fg-1">Run scripts</span>
        <ArrayBadge layer={layer} />
        <div className="flex-1" />
        <Select
          options={[
            { value: 'single', label: 'one at a time' },
            { value: 'concurrent', label: 'concurrent' },
          ]}
          data-testid="scripts-run-mode"
          value={runMode}
          onChange={(e) => onSetMode(e.target.value as 'concurrent' | 'single')}
        />
      </div>

      <div className="flex flex-col gap-1">
        {draft.map((script, idx) => (
          <div
            key={idx}
            className="flex items-center gap-1"
            data-testid={`scripts-run-row-${idx}`}
          >
            <Cell
              testId={`scripts-run-name-${idx}`}
              value={script.name}
              placeholder="name"
              onChange={(v) => patch(idx, 'name', v)}
              onBlur={() => commit(draft)}
            />
            <Cell
              testId={`scripts-run-command-${idx}`}
              value={script.command}
              placeholder="command"
              onChange={(v) => patch(idx, 'command', v)}
              onBlur={() => commit(draft)}
            />
            <Cell
              testId={`scripts-run-label-${idx}`}
              value={script.label ?? ''}
              placeholder="label (optional)"
              onChange={(v) => patch(idx, 'label', v)}
              onBlur={() => commit(draft)}
            />
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0 text-2xs text-danger hover:text-danger-hover"
              data-testid={`scripts-run-remove-${idx}`}
              aria-label={`Remove run script ${idx + 1}`}
              onClick={() => commit(draft.filter((_, i) => i !== idx))}
            >
              ✕
            </Button>
          </div>
        ))}
        {draft.length === 0 ? (
          <div className="text-xs text-fg-3">No run scripts.</div>
        ) : null}
      </div>

      <Button
        variant="secondary"
        size="sm"
        className="mt-1 text-2xs"
        data-testid="scripts-run-add"
        onClick={() => commit([...draft, { name: '', command: '' }])}
      >
        + Add run script
      </Button>
    </div>
  );
}

// --- [env] -------------------------------------------------------------------

/** An env var as an ordered [key, value] pair for stable row editing. */
type EnvPair = [string, string];

function EnvEditor({
  env,
  layer,
  onSet,
}: {
  env: Record<string, string>;
  layer: SettingLayer | undefined;
  onSet: (next: Record<string, string>) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<EnvPair[]>(() => Object.entries(env));
  useEffect(() => setDraft(Object.entries(env)), [signatureOf(env)]);

  /** Serialise the pairs back to a record (last write wins on a duplicate key) + commit. */
  const commit = (pairs: EnvPair[]): void => {
    setDraft(pairs);
    const record: Record<string, string> = {};
    for (const [k, v] of pairs) if (k !== '') record[k] = v;
    onSet(record);
  };

  const patch = (idx: number, slot: 0 | 1, value: string): void => {
    setDraft((cur) =>
      cur.map((pair, i) => {
        if (i !== idx) return pair;
        const next: EnvPair = [pair[0], pair[1]];
        next[slot] = value;
        return next;
      }),
    );
  };

  return (
    <div data-testid="env-editor">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-medium text-fg-1">
          Environment variables
        </span>
        <ArrayBadge layer={layer} />
      </div>
      <div className="flex flex-col gap-1">
        {draft.map((pair, idx) => (
          <div
            key={idx}
            className="flex items-center gap-1"
            data-testid={`env-row-${idx}`}
          >
            <Cell
              testId={`env-key-${idx}`}
              value={pair[0]}
              placeholder="KEY"
              onChange={(v) => patch(idx, 0, v)}
              onBlur={() => commit(draft)}
            />
            <Cell
              testId={`env-value-${idx}`}
              value={pair[1]}
              placeholder="value"
              onChange={(v) => patch(idx, 1, v)}
              onBlur={() => commit(draft)}
            />
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0 text-2xs text-danger hover:text-danger-hover"
              data-testid={`env-remove-${idx}`}
              aria-label={`Remove env var ${idx + 1}`}
              onClick={() => commit(draft.filter((_, i) => i !== idx))}
            >
              ✕
            </Button>
          </div>
        ))}
        {draft.length === 0 ? (
          <div className="text-xs text-fg-3">No environment overrides.</div>
        ) : null}
      </div>
      <Button
        variant="secondary"
        size="sm"
        className="mt-1 text-2xs"
        data-testid="env-add"
        onClick={() => commit([...draft, ['', '']])}
      >
        + Add variable
      </Button>
    </div>
  );
}

// --- [mcp] -------------------------------------------------------------------

function McpEditor({
  mcp,
  layer,
  onSet,
}: {
  mcp: McpServerConfig[];
  layer: SettingLayer | undefined;
  onSet: (next: McpServerConfig[]) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<McpServerConfig[]>(mcp);
  useEffect(() => setDraft(mcp), [signatureOf(mcp)]);

  const commit = (next: McpServerConfig[]): void => {
    setDraft(next);
    onSet(next);
  };

  const patch = (idx: number, key: 'name' | 'command', value: string): void => {
    setDraft((cur) =>
      cur.map((s, i) => (i === idx ? { ...s, [key]: value } : s)),
    );
  };

  return (
    <div data-testid="mcp-editor">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-medium text-fg-1">MCP servers</span>
        <ArrayBadge layer={layer} />
      </div>
      <div className="flex flex-col gap-1">
        {draft.map((server, idx) => (
          <div
            key={idx}
            className="flex items-center gap-1"
            data-testid={`mcp-row-${idx}`}
          >
            <Cell
              testId={`mcp-name-${idx}`}
              value={server.name}
              placeholder="name"
              onChange={(v) => patch(idx, 'name', v)}
              onBlur={() => commit(draft)}
            />
            <Cell
              testId={`mcp-command-${idx}`}
              value={server.command}
              placeholder="command"
              onChange={(v) => patch(idx, 'command', v)}
              onBlur={() => commit(draft)}
            />
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0 text-2xs text-danger hover:text-danger-hover"
              data-testid={`mcp-remove-${idx}`}
              aria-label={`Remove MCP server ${idx + 1}`}
              onClick={() => commit(draft.filter((_, i) => i !== idx))}
            >
              ✕
            </Button>
          </div>
        ))}
        {draft.length === 0 ? (
          <div className="text-xs text-fg-3">No MCP servers.</div>
        ) : null}
      </div>
      <Button
        variant="secondary"
        size="sm"
        className="mt-1 text-2xs"
        data-testid="mcp-add"
        onClick={() => commit([...draft, { name: '', command: '' }])}
      >
        + Add MCP server
      </Button>
    </div>
  );
}

/**
 * A stable signature for an array/record used to decide when a hot-reload should re-seed a
 * draft. JSON is fine here — these collections are small and only ever hold plain data.
 */
function signatureOf(value: unknown): string {
  return JSON.stringify(value);
}
