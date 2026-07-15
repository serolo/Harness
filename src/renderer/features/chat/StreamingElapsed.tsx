import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

export interface StreamingElapsedProps {
  startedAt?: number;
}

function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}m ${rest}s`;
}

export function StreamingElapsed({
  startedAt,
}: StreamingElapsedProps): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  const start = startedAt ?? now;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div
      className="flex items-center gap-2 text-sm text-fg-3"
      data-testid="turn-elapsed"
    >
      <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
      <span className="tabular-nums">{elapsedLabel(now - start)}</span>
    </div>
  );
}
