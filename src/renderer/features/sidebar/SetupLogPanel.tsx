// Scrollable monospace log panel streamed during workspace creation.
//
// Receives an array of log line strings (appended as `workspace:create` emits
// `{ kind: 'setupLog' }` chunks). Auto-scrolls to the bottom so the user
// always sees the latest output without manual interaction.

import { useEffect, useRef } from 'react';

export interface SetupLogPanelProps {
  /** Accumulated log lines from the setup script. */
  lines: string[];
}

/**
 * Renders accumulated setup-script output in a fixed-height scrollable box.
 * Auto-scrolls to the bottom whenever `lines` grows.
 */
export function SetupLogPanel({
  lines,
}: SetupLogPanelProps): React.JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom whenever a new line arrives.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [lines]);

  return (
    <div
      className="h-40 overflow-y-auto rounded border border-slate-700 bg-slate-950 p-2 font-mono text-[11px] leading-relaxed text-slate-300"
      data-testid="setup-log"
      aria-label="Setup log output"
      aria-live="polite"
    >
      {lines.length === 0 ? (
        <span className="text-slate-600">Waiting for output…</span>
      ) : (
        lines.map((line, i) => (
          // Lines may be empty (blank separator lines from the script); render
          // a non-breaking space so the row retains its height.
          <div key={i}>{line || ' '}</div>
        ))
      )}
      {/* Sentinel element we scroll into view. */}
      <div ref={bottomRef} />
    </div>
  );
}
