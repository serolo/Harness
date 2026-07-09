// ChatPanel — the center-pane chat for the selected workspace. Wires `useChat`
// (history + streaming) to the Transcript + Composer. Renders an empty state when no
// workspace is selected.

import { Transcript } from './Transcript';
import { Composer } from './Composer';
import { useChat } from './useChat';

export interface ChatPanelProps {
  workspaceId: string | null;
}

export function ChatPanel({ workspaceId }: ChatPanelProps): React.JSX.Element {
  const { turns, isBusy, sendTurn, interrupt } = useChat(workspaceId);

  if (!workspaceId) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-sm text-slate-600"
        data-testid="chat-empty"
      >
        Select a workspace to begin.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="chat-panel">
      <Transcript turns={turns} />
      <Composer
        isBusy={isBusy}
        onSend={(prompt, attachments, mode) =>
          sendTurn(prompt, attachments, mode)
        }
        onInterrupt={interrupt}
      />
    </div>
  );
}
