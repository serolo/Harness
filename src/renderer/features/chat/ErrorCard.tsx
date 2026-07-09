// Renders an error AgentEvent. Message only (no secrets/stack) — mirrors the main-side
// discipline of carrying only `error.message`.

export interface ErrorCardProps {
  message: string;
}

export function ErrorCard({ message }: ErrorCardProps): React.JSX.Element {
  return (
    <div
      className="my-1 rounded-md border border-red-900/60 bg-red-950/40 px-2 py-1 text-sm text-red-300"
      data-testid="error-card"
      role="alert"
    >
      {message}
    </div>
  );
}
