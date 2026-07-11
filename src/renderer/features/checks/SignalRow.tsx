// SignalRow — one compact row per `CheckItem` in the Checks panel: a severity-colored
// dot, a per-source glyph/tag, and the item's label. Purely presentational; the source
// tag + colors are derived from `item.source` / `item.severity`. Rich per-source detail
// (CI runs, review threads, deployments, todos) is rendered by the panel, not here.

import type { CheckSeverity, CheckSource, CheckItem } from '@shared/checks';

/** Token text color per severity (blocker = danger, gating the merge). */
const SEVERITY_TEXT: Record<CheckSeverity, string> = {
  ok: 'text-ok',
  pending: 'text-info',
  warning: 'text-warn',
  blocker: 'text-danger',
};

/** Token dot color per severity. */
const SEVERITY_DOT: Record<CheckSeverity, string> = {
  ok: 'bg-ok',
  pending: 'bg-info',
  warning: 'bg-warn',
  blocker: 'bg-danger',
};

/** Short uppercase tag shown per source (a text "icon" — no icon dep in this repo). */
const SOURCE_TAG: Record<CheckSource, string> = {
  git: 'GIT',
  pr: 'PR',
  ci: 'CI',
  deployment: 'DEP',
  review: 'REV',
  todos: 'TODO',
};

export interface SignalRowProps {
  item: CheckItem;
}

export function SignalRow({ item }: SignalRowProps): React.JSX.Element {
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 text-xs"
      data-testid={`signal-row-${item.source}`}
      data-severity={item.severity}
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[item.severity]}`}
        aria-hidden="true"
      />
      <span className="w-10 shrink-0 font-mono text-2xs uppercase tracking-caps text-fg-3">
        {SOURCE_TAG[item.source]}
      </span>
      <span
        className={`min-w-0 flex-1 truncate ${SEVERITY_TEXT[item.severity]}`}
      >
        {item.label}
      </span>
    </div>
  );
}
