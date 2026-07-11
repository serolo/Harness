// Streaming assistant text, rendered as safe markdown (see markdown.tsx).

import { Markdown } from './markdown';

export interface TextMessageProps {
  delta: string;
}

export function TextMessage({ delta }: TextMessageProps): React.JSX.Element {
  return (
    <div className="text-fg-1" data-testid="chat-text">
      <Markdown text={delta} />
    </div>
  );
}
