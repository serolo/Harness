import { Markdown } from './markdown';

export function UserMessage({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex min-w-0 justify-end" data-testid="chat-user-message">
      <div
        className="min-w-0 w-fit max-w-[82%] rounded-3 bg-bg-3 px-4 py-3 text-fg-1 [overflow-wrap:anywhere] [&>p:first-child]:mt-0 [&>p:last-child]:mb-0"
        data-testid="chat-user-message-bubble"
      >
        <Markdown text={text} />
      </div>
    </div>
  );
}
