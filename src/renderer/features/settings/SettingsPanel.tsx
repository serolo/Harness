// SettingsPanel — the settings editor surface (Phase 6, Track B/G). Renders the
// declarative section/field catalogue (`fields.ts`) as rows, each showing the effective
// value + a provenance badge + a write-to-(user)-layer control. Data + writes come from
// `useSettings`; this component is view + wiring only (all main access is inside the
// hook via `@renderer/ipc`).

import { useState } from 'react';

import type { SettingLayer, SettingsIssue } from '@shared/settings';
import { useSettings } from './useSettings';
import { SETTINGS_SECTIONS, getAtPath } from './fields';
import { SettingRow } from './SettingRow';
import { RunScriptEditor } from './RunScriptEditor';

export interface SettingsPanelProps {
  /** Close affordance for the overlay host (a header button). */
  onClose?: () => void;
}

export function SettingsPanel({
  onClose,
}: SettingsPanelProps): React.JSX.Element {
  const { effective, provenance, issues, loading, error, set } = useSettings();

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-slate-950 text-slate-200"
      data-testid="settings-panel"
    >
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
        <span className="text-sm font-semibold text-slate-100">Settings</span>
        {onClose ? (
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800"
            data-testid="settings-close"
            onClick={onClose}
          >
            Close
          </button>
        ) : null}
      </div>

      {error ? (
        <div
          className="border-b border-rose-900/50 bg-rose-950/40 px-4 py-2 text-xs text-rose-300"
          data-testid="settings-error"
        >
          {error.message}
        </div>
      ) : null}

      <SettingsIssuesBanner issues={issues} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && effective === null ? (
          <div
            className="flex h-full items-center justify-center p-6 text-sm text-slate-600"
            data-testid="settings-loading"
          >
            Loading settings…
          </div>
        ) : effective === null ? (
          <div
            className="flex h-full items-center justify-center p-6 text-sm text-slate-600"
            data-testid="settings-empty"
          >
            No settings available.
          </div>
        ) : (
          SETTINGS_SECTIONS.map((section) => (
            <section
              key={section.title}
              data-testid={`settings-section-${section.title.toLowerCase()}`}
            >
              <h3 className="px-3 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-slate-500">
                {section.title}
              </h3>
              <div className="divide-y divide-slate-900">
                {section.fields.map((field) => (
                  <SettingRow
                    key={field.keyPath}
                    field={field}
                    value={getAtPath(effective, field.keyPath)}
                    layer={
                      provenance[field.keyPath] as SettingLayer | undefined
                    }
                    onSet={(keyPath, value) => {
                      void set(keyPath, value);
                    }}
                  />
                ))}
              </div>
            </section>
          ))
        )}
        {effective ? (
          <RunScriptEditor
            effective={effective}
            provenance={provenance}
            onSet={(keyPath, value) => {
              void set(keyPath, value);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * A dismissible banner listing the layer validation issues surfaced by the non-throwing
 * load (`settings:getIssues`) — a bad TOML/zod layer that was SKIPPED rather than crashing
 * the merge. Each row points at the offending `{file, keyPath?, message}` so the user can
 * fix the source file. Dismissal is per-issue-set: a new set (e.g. after a hot-reload that
 * changed the issues) re-shows the banner. Renders nothing when every layer parsed cleanly.
 */
function SettingsIssuesBanner({
  issues,
}: {
  issues: SettingsIssue[];
}): React.JSX.Element | null {
  // Key the dismissal on the issue-set signature so a *different* set of issues (a new
  // bad edit after the user dismissed the last one) surfaces the banner again.
  const signature = issues
    .map((i) => `${i.file}|${i.keyPath ?? ''}|${i.message}`)
    .join('\n');
  const [dismissed, setDismissed] = useState<string | null>(null);

  if (issues.length === 0 || dismissed === signature) return null;

  return (
    <div
      className="border-b border-amber-900/50 bg-amber-950/40 px-4 py-2 text-xs text-amber-200"
      data-testid="settings-issues"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">
          {issues.length === 1
            ? '1 settings issue — a layer was skipped'
            : `${issues.length} settings issues — layers were skipped`}
        </span>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-amber-300/80 hover:bg-amber-900/40"
          data-testid="settings-issues-dismiss"
          onClick={() => setDismissed(signature)}
        >
          Dismiss
        </button>
      </div>
      <ul className="mt-1 flex flex-col gap-0.5">
        {issues.map((issue, idx) => (
          <li key={idx} data-testid="settings-issue" className="truncate">
            <span className="text-amber-400">
              {shortFile(issue.file)}
              {issue.keyPath ? ` · ${issue.keyPath}` : ''}
            </span>{' '}
            — {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Trim a settings-file path to its basename for a compact banner (full path is in the file). */
function shortFile(file: string): string {
  const parts = file.split(/[/\\]/);
  return parts[parts.length - 1] || file;
}
