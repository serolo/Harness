import { BookOpenCheck, BookOpenText, CircleAlert } from 'lucide-react';

import type {
  KnowledgeTurnStatus,
  KnowledgeTurnStatusEvent,
} from '@shared/harness';

const COPY: Record<KnowledgeTurnStatus, string> = {
  not_configured: 'Knowledge was not configured for this turn',
  prepared: 'Knowledge was prepared for this turn',
  searched: 'Knowledge was searched, but no page was read',
  read: 'Knowledge was used',
  no_results: 'Knowledge was searched, but no relevant results were found',
  unused: 'Knowledge was available but not consulted',
  fallback: 'Knowledge used the basic search fallback',
  failed: 'Knowledge retrieval encountered an error; the turn continued',
};

function StatusIcon({ status }: { status: KnowledgeTurnStatus }) {
  if (status === 'failed') {
    return <CircleAlert className="h-3.5 w-3.5 text-danger" aria-hidden />;
  }
  if (status === 'read' || status === 'fallback') {
    return <BookOpenCheck className="h-3.5 w-3.5 text-success" aria-hidden />;
  }
  return <BookOpenText className="h-3.5 w-3.5 text-fg-3" aria-hidden />;
}

export function KnowledgeStatusCard({
  status,
  provider,
}: Pick<KnowledgeTurnStatusEvent, 'status' | 'provider'>): React.JSX.Element {
  return (
    <div
      className="mx-2 flex items-center gap-2 px-1 py-1 text-xs text-fg-3"
      data-testid="knowledge-status-event"
      data-status={status}
    >
      <StatusIcon status={status} />
      <span>{COPY[status]}</span>
      {provider && provider !== 'none' ? (
        <span className="text-fg-4">· {provider}</span>
      ) : null}
    </div>
  );
}
