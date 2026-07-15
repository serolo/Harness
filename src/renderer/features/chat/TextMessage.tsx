// Streaming assistant text, rendered as safe markdown (see markdown.tsx).

import { Markdown } from './markdown';

export interface TextMessageProps {
  delta: string;
  onOpenFile?: (path: string) => void;
}

export function TextMessage({
  delta,
  onOpenFile,
}: TextMessageProps): React.JSX.Element {
  return (
    <div className="min-w-0 text-fg-1" data-testid="chat-text">
      <Markdown text={delta} onOpenFile={onOpenFile} />
    </div>
  );
}
