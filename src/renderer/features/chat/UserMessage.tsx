import { Markdown } from './markdown';

export function UserMessage({ text }: { text: string }): React.JSX.Element {
  return (
    <div
      className="flex justify-end"
      data-testid="chat-user-message"
    >
      <div className="w-fit max-w-[82%] rounded-3 bg-bg-3 px-4 py-3 text-fg-1 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0">
        <Markdown text={text} />
      </div>
    </div>
  );
}
