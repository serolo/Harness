import { useEffect, useState } from 'react';
import type { MetaAgentDetail } from '@shared/agents';
import { Button, Dialog, Select, Textarea } from '@renderer/components/ui';
import { invoke } from '@renderer/ipc';

export function AgentEditor({
  projectId,
  agent,
  onClose,
  onSaved,
}: {
  projectId: string;
  agent: MetaAgentDetail;
  onClose: () => void;
  onSaved: (agent: MetaAgentDetail) => void;
}): React.JSX.Element {
  const [path, setPath] = useState(agent.files[0] ?? 'config.yaml');
  const [content, setContent] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string | null>>({});
  const [newPath, setNewPath] = useState('');
  const [diagnostics, setDiagnostics] = useState(agent.diagnostics);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (Object.prototype.hasOwnProperty.call(drafts, path)) {
      setContent(drafts[path] ?? '');
      return;
    }
    let active = true;
    void invoke('metaAgent:readFile', { projectId, agentId: agent.id, path })
      .then((file) => {
        if (active) {
          setContent(file.content);
          setDiagnostics(file.diagnostics);
        }
      })
      .catch((error: unknown) => {
        if (active)
          setDiagnostics([
            {
              severity: 'error',
              code: 'read_failed',
              message:
                error instanceof Error ? error.message : 'Could not read file.',
              file: path,
            },
          ]);
      });
    return () => {
      active = false;
    };
  }, [agent.id, drafts, path, projectId]);
  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const pending = { ...drafts, [path]: content };
      const edits = Object.entries(pending).map(([filePath, fileContent]) => ({
        path: filePath,
        content: fileContent,
      }));
      const nextDiagnostics = (
        await Promise.all(
          edits
            .filter(
              (file): file is { path: string; content: string } =>
                file.content !== null,
            )
            .map((file) =>
              invoke('metaAgent:validateFile', {
                projectId,
                agentId: agent.id,
                path: file.path,
                content: file.content,
              }),
            ),
        )
      ).flat();
      setDiagnostics(nextDiagnostics);
      if (nextDiagnostics.some((item) => item.severity === 'error')) return;
      const next = await invoke('metaAgent:saveBundleFiles', {
        projectId,
        agentId: agent.id,
        files: edits,
      });
      setDrafts({});
      onSaved(next);
    } catch (error) {
      setDiagnostics([
        {
          severity: 'error',
          code: 'save_failed',
          message:
            error instanceof Error ? error.message : 'Could not save file.',
          file: path,
        },
      ]);
    } finally {
      setSaving(false);
    }
  };
  const visibleFiles = [
    ...new Set([
      ...agent.files,
      ...Object.entries(drafts)
        .filter(([, value]) => value !== null)
        .map(([file]) => file),
    ]),
  ].filter((file) => drafts[file] !== null);
  const switchPath = (nextPath: string): void => {
    if (agent.editable)
      setDrafts((current) => ({ ...current, [path]: content }));
    setPath(nextPath);
  };
  const addFile = (): void => {
    const candidate = newPath.trim();
    if (!candidate) return;
    const initial = candidate.endsWith('config.yaml')
      ? 'version: 1\nname: New role\nprompt: Describe the assignment.\nexecutor:\n  harness: claude_code\n  mode: default\n'
      : '';
    setDrafts((current) => ({
      ...current,
      [path]: content,
      [candidate]: initial,
    }));
    setNewPath('');
    setPath(candidate);
    setContent(initial);
  };
  const removeFile = (): void => {
    if (path === 'config.yaml') return;
    setDrafts((current) => ({
      ...current,
      [path]: null,
    }));
    setPath('config.yaml');
  };
  return (
    <Dialog
      fullScreen
      title={`${agent.name} bundle`}
      onClose={onClose}
      contentClassName="flex min-h-0 flex-col gap-3 p-4"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {agent.editable ? (
            <Button
              variant="primary"
              disabled={saving}
              onClick={() => void save()}
            >
              Validate and save atomically
            </Button>
          ) : null}
        </>
      }
    >
      <Select
        value={path}
        options={visibleFiles.map((file) => ({ value: file, label: file }))}
        onChange={(event) => switchPath(event.target.value)}
      />
      {agent.editable ? (
        <div className="flex gap-2">
          <input
            className="min-w-0 flex-1 rounded-2 border border-border-1 bg-bg-2 px-2 py-1 text-sm text-fg-1"
            aria-label="New bundle file path"
            placeholder="agents/reviewer/config.yaml or INSTRUCTIONS.md"
            value={newPath}
            onChange={(event) => setNewPath(event.target.value)}
          />
          <Button
            variant="secondary"
            disabled={!newPath.trim()}
            onClick={addFile}
          >
            Add file
          </Button>
          <Button
            variant="danger"
            disabled={path === 'config.yaml'}
            onClick={removeFile}
          >
            Remove file
          </Button>
        </div>
      ) : null}
      <Textarea
        className="min-h-0 flex-1 resize-none font-mono text-sm"
        value={content}
        readOnly={!agent.editable}
        aria-label="Agent bundle file"
        onChange={(event) => setContent(event.target.value)}
      />
      <div aria-live="polite" className="space-y-1 text-xs">
        {diagnostics.map((item, index) => (
          <div
            key={`${item.code}-${index}`}
            className={
              item.severity === 'error' ? 'text-danger' : 'text-warning'
            }
          >
            {item.file
              ? `${item.file}${item.line ? `:${item.line}` : ''}: `
              : ''}
            {item.message}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
