// The chat composer: multiline prompt, mode selector (gated by harness capabilities),
// a minimal file-attach affordance, and a Send/Interrupt button tied to `isBusy`.

import { useEffect, useState } from 'react';
import type { AgentMode, Attachment } from '@shared/harness';
import { useWorkspacesStore } from '@renderer/stores/workspaces';
import { useSelectedHarnessCapabilities } from '@renderer/stores/harness';
import { useComposerStore } from '@renderer/stores/composer';
import { Button, Input, Select, Textarea } from '@renderer/components/ui';
import { AttachmentBar } from './AttachmentBar';

export interface ComposerProps {
  isBusy: boolean;
  disabled?: boolean;
  onSend: (
    prompt: string,
    attachments: Attachment[],
    mode: AgentMode,
  ) => void | Promise<void>;
  onInterrupt: () => void | Promise<void>;
}

const MODES: { value: AgentMode; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'plan', label: 'Plan' },
  { value: 'auto_accept', label: 'Auto-accept' },
];

export function Composer({
  isBusy,
  disabled,
  onSend,
  onInterrupt,
}: ComposerProps): React.JSX.Element {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<AgentMode>('default');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pathDraft, setPathDraft] = useState('');

  // The composer always targets the currently selected workspace (its host
  // <ChatPanel> is rendered with `workspaceId={selectedWorkspaceId}`), so read the
  // id straight from the store for the one-time pending-prompt hand-off.
  const selectedWorkspaceId = useWorkspacesStore((s) => s.selectedWorkspaceId);
  const takePendingPrompt = useComposerStore((s) => s.takePendingPrompt);

  // Consume any pending prompt seeded for this workspace (e.g. by the "From issue"
  // create flow) exactly once. Keyed on the workspace id: it fires on mount and when
  // the selection changes; `takePendingPrompt` clears the value, so switching away and
  // back after it was consumed does not re-seed the input. `takePendingPrompt` is a
  // stable Zustand action, so it never re-fires the effect on its own.
  useEffect(() => {
    if (selectedWorkspaceId === null) return;
    const pending = takePendingPrompt(selectedWorkspaceId);
    if (pending !== undefined && pending !== '') {
      setText(pending);
    }
  }, [selectedWorkspaceId, takePendingPrompt]);

  // Gate the plan mode on the SELECTED workspace's harness capability (one centralized
  // read via the harness store — never a hardcoded harness id). Optimistic default: show
  // Plan until caps load (undefined), hide only when the harness explicitly lacks it.
  const capabilities = useSelectedHarnessCapabilities();
  const supportsPlan = capabilities?.supportsPlanMode ?? true;

  const modes = supportsPlan ? MODES : MODES.filter((m) => m.value !== 'plan');
  const canSend = !isBusy && !disabled && text.trim().length > 0;

  function send(): void {
    if (!canSend) return;
    void onSend(text, attachments, mode);
    setText('');
    setAttachments([]);
  }

  function addPath(): void {
    const path = pathDraft.trim();
    if (path === '') return;
    setAttachments((prev) => [...prev, { type: 'file', path }]);
    setPathDraft('');
  }

  return (
    <div
      className="border-t border-border-1 bg-surface-panel"
      data-testid="composer"
    >
      <AttachmentBar
        attachments={attachments}
        onRemove={(i) =>
          setAttachments((prev) => prev.filter((_, idx) => idx !== i))
        }
      />
      <div className="flex items-end gap-2 p-3">
        <Textarea
          className="min-h-[42px] flex-1"
          rows={2}
          placeholder="Message the agent…  (Enter to send, Shift+Enter for newline)"
          value={text}
          disabled={disabled}
          data-testid="composer-input"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="flex flex-col gap-1">
          <Select
            options={modes.map((m) => ({ value: m.value, label: m.label }))}
            value={mode}
            data-testid="composer-mode"
            onChange={(e) => setMode(e.target.value as AgentMode)}
          />
          {isBusy ? (
            <Button
              variant="danger"
              data-testid="composer-interrupt"
              onClick={() => void onInterrupt()}
            >
              Stop
            </Button>
          ) : (
            <Button
              variant="primary"
              data-testid="composer-send"
              disabled={!canSend}
              onClick={send}
            >
              Send
            </Button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 px-3 pb-2">
        <Input
          mono
          className="w-64"
          placeholder="Attach a file path…"
          value={pathDraft}
          data-testid="composer-attach-input"
          onChange={(e) => setPathDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addPath();
            }
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          data-testid="composer-attach"
          onClick={addPath}
        >
          + Attach
        </Button>
      </div>
    </div>
  );
}
