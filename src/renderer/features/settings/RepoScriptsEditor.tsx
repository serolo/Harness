import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import type { NamedScript, ScriptsSettings } from '@shared/settings';
import { Button, Input, Select, Textarea } from '@renderer/components/ui';

interface RepoScriptsEditorProps {
  scripts: ScriptsSettings;
  onSet: (keyPath: string, value: unknown) => void;
}

export function RepoScriptsEditor({
  scripts,
  onSet,
}: RepoScriptsEditorProps): React.JSX.Element {
  return (
    <div className="space-y-8" data-testid="repo-scripts-editor">
      <LifecycleScript
        title="Setup script"
        description="Runs when a new workspace is created"
        value={scripts.setup ?? ''}
        testId="repo-setup-script"
        onCommit={(value) => onSet('scripts.setup', value)}
      />
      <div className="border-t border-border-1" />
      <LifecycleScript
        title="Archive script"
        description="Runs before a workspace is archived"
        value={scripts.archive ?? ''}
        testId="repo-archive-script"
        onCommit={(value) => onSet('scripts.archive', value)}
      />
      <div className="border-t border-border-1" />
      <RunScripts
        scripts={scripts.run}
        mode={scripts.run_mode}
        onCommit={(value) => onSet('scripts.run', value)}
        onModeChange={(value) => onSet('scripts.run_mode', value)}
      />
    </div>
  );
}

function LifecycleScript({
  title,
  description,
  value,
  testId,
  onCommit,
}: {
  title: string;
  description: string;
  value: string;
  testId: string;
  onCommit: (value: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <section>
      <h2 className="text-base font-semibold text-fg-1">{title}</h2>
      <p className="mb-3 mt-1 text-sm text-fg-2">{description}</p>
      <Textarea
        mono
        rows={3}
        className="w-full"
        data-testid={testId}
        value={draft}
        placeholder="# Enter a shell command"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== value) onCommit(draft);
        }}
      />
    </section>
  );
}

function RunScripts({
  scripts,
  mode,
  onCommit,
  onModeChange,
}: {
  scripts: NamedScript[];
  mode: ScriptsSettings['run_mode'];
  onCommit: (scripts: NamedScript[]) => void;
  onModeChange: (mode: ScriptsSettings['run_mode']) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(scripts);
  useEffect(() => setDraft(scripts), [JSON.stringify(scripts)]);

  const patch = (
    index: number,
    key: 'name' | 'label' | 'command',
    value: string,
  ): void => {
    setDraft((current) =>
      current.map((script, itemIndex) =>
        itemIndex === index ? { ...script, [key]: value } : script,
      ),
    );
  };

  return (
    <section data-testid="repo-run-scripts">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-fg-1">Run scripts</h2>
          <p className="mt-1 text-sm text-fg-2">
            Shortcuts for quick actions, like running your dev server or test suite
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            aria-label="Run script mode"
            data-testid="repo-run-mode"
            value={mode}
            options={[
              { value: 'single', label: 'One at a time' },
              { value: 'concurrent', label: 'Concurrent' },
            ]}
            onChange={(event) =>
              onModeChange(event.target.value as ScriptsSettings['run_mode'])
            }
          />
          <Button
            data-testid="repo-run-add"
            onClick={() => {
              const next = [
                ...draft,
                { name: `script-${draft.length + 1}`, command: '' },
              ];
              setDraft(next);
              onCommit(next);
            }}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add
          </Button>
        </div>
      </div>

      {draft.length === 0 ? (
        <p className="rounded-3 border border-dashed border-border-2 px-4 py-6 text-sm text-fg-3">
          No run scripts yet. Add one to get started.
        </p>
      ) : (
        <div className="space-y-3">
          {draft.map((script, index) => (
            <div
              key={index}
              className="rounded-3 border border-border-1 bg-surface-well p-3"
              data-testid={`repo-run-row-${index}`}
            >
              <div className="flex gap-2">
                <Input
                  className="w-40"
                  data-testid={`repo-run-name-${index}`}
                  value={script.name}
                  placeholder="name"
                  onChange={(event) => patch(index, 'name', event.target.value)}
                  onBlur={() => onCommit(draft)}
                />
                <Input
                  className="min-w-0 flex-1"
                  data-testid={`repo-run-label-${index}`}
                  value={script.label ?? ''}
                  placeholder="Label (optional)"
                  onChange={(event) => patch(index, 'label', event.target.value)}
                  onBlur={() => onCommit(draft)}
                />
                <Button
                  variant="ghost"
                  aria-label={`Remove ${script.label || script.name}`}
                  data-testid={`repo-run-remove-${index}`}
                  onClick={() => {
                    const next = draft.filter((_, itemIndex) => itemIndex !== index);
                    setDraft(next);
                    onCommit(next);
                  }}
                >
                  <Trash2 className="h-4 w-4 text-danger" aria-hidden />
                </Button>
              </div>
              <Input
                mono
                className="mt-2 w-full"
                data-testid={`repo-run-command-${index}`}
                value={script.command}
                placeholder="Command, e.g. npm run dev"
                onChange={(event) => patch(index, 'command', event.target.value)}
                onBlur={() => onCommit(draft)}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
