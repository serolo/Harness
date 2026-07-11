// Renders an error AgentEvent. Message only (no secrets/stack) — mirrors the main-side
// discipline of carrying only `error.message`.

export interface ErrorCardProps {
  message: string;
}

export function ErrorCard({ message }: ErrorCardProps): React.JSX.Element {
  return (
    <div
      className="my-1 rounded-2 border border-danger bg-danger-muted px-2 py-1 text-base text-danger"
      data-testid="error-card"
      role="alert"
    >
      {message}
    </div>
  );
}
