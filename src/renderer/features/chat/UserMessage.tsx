// A prompt sent by the user. It is kept visually distinct from agent output and
// aligned to the right, matching the conversation treatment in the reference UI.

export interface UserMessageProps {
  text: string;
}

export function UserMessage({ text }: UserMessageProps): React.JSX.Element {
  return (
    <div className="flex justify-end" data-testid="chat-user-message">
      <div className="max-w-[72%] whitespace-pre-wrap break-words rounded-4 bg-chat-user px-5 py-3 text-md leading-relaxed text-fg-1">
        {text}
      </div>
    </div>
  );
}
