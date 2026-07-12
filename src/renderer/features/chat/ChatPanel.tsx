// ChatPanel — the center-pane chat for the selected workspace. Wires `useChat`
// (history + streaming) to the Transcript + Composer. Renders an empty state when no
// workspace is selected.

import { History, Plus } from 'lucide-react';
import { Transcript } from './Transcript';
import { Composer } from './Composer';
import { useChat } from './useChat';

export interface ChatPanelProps {
  workspaceId: string | null;
}

export function ChatPanel({ workspaceId }: ChatPanelProps): React.JSX.Element {
  const { turns, isBusy, sendTurn, interrupt, clear } = useChat(workspaceId);

  if (!workspaceId) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-base text-fg-3"
        data-testid="chat-empty"
      >
        Select a workspace to begin.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-app" data-testid="chat-panel">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border-1 bg-surface-panel px-5">
        <div className="flex h-full items-center gap-8">
          <div className="flex h-full items-center border-b-2 border-accent px-1 text-sm font-semibold text-fg-1">
            Claude
          </div>
          <button
            type="button"
            className="rounded-1 p-1 text-fg-3 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Clear chat"
            data-testid="chat-clear"
            disabled={isBusy}
            onClick={() => void clear()}
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <button
          type="button"
          className="rounded-1 p-1 text-fg-3 transition-colors duration-fast ease-out hover:bg-bg-3 hover:text-fg-1"
          aria-label="Chat history"
        >
          <History className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <Transcript turns={turns} />
      <Composer
        isBusy={isBusy}
        workspaceId={workspaceId}
        onSend={(prompt, attachments, mode, harness, displayPrompt) =>
          sendTurn(prompt, attachments, mode, harness, displayPrompt)
        }
        onInterrupt={interrupt}
        onClear={clear}
      />
    </div>
  );
}
