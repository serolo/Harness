import { Markdown } from './markdown';

export function UserMessage({ text }: { text: string }): React.JSX.Element {
  return (
    <div
      className="ml-auto flex max-w-[82%] justify-end rounded-3 bg-bg-3 px-4 py-3 text-fg-1"
      data-testid="chat-user-message"
    >
      <Markdown text={text} />
    </div>
  );
}
