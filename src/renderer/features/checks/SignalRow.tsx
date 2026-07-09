// SignalRow — one compact row per `CheckItem` in the Checks panel: a severity-colored
// dot, a per-source glyph/tag, and the item's label. Purely presentational; the source
// tag + colors are derived from `item.source` / `item.severity`. Rich per-source detail
// (CI runs, review threads, deployments, todos) is rendered by the panel, not here.

import type { CheckSeverity, CheckSource, CheckItem } from '@shared/checks';

/** Tailwind text color per severity (blocker = rose/red, gating the merge). */
const SEVERITY_TEXT: Record<CheckSeverity, string> = {
  ok: 'text-emerald-400',
  pending: 'text-sky-400',
  warning: 'text-amber-400',
  blocker: 'text-rose-400',
};

/** Tailwind dot color per severity. */
const SEVERITY_DOT: Record<CheckSeverity, string> = {
  ok: 'bg-emerald-500',
  pending: 'bg-sky-500',
  warning: 'bg-amber-500',
  blocker: 'bg-rose-500',
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
      <span className="w-10 shrink-0 font-mono text-[10px] uppercase tracking-wide text-slate-500">
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
