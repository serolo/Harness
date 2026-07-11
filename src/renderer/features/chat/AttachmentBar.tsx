// Shows the attachments staged for the next turn. Diff-comment attachments arrive from
// Phase 4 via a shared store (SEAM) — this bar renders whatever the composer holds.

import type { Attachment } from '@shared/harness';
import { Badge } from '@renderer/components/ui';

export interface AttachmentBarProps {
  attachments: Attachment[];
  onRemove: (index: number) => void;
}

/** A short, secret-free label for an attachment chip. */
function label(a: Attachment): string {
  switch (a.type) {
    case 'file':
      return `📄 ${a.path}`;
    case 'image':
      return `🖼 ${a.path}`;
    case 'diff_comment':
      return `💬 ${a.file}:${a.lineStart}-${a.lineEnd}`;
    default:
      return 'attachment';
  }
}

export function AttachmentBar({
  attachments,
  onRemove,
}: AttachmentBarProps): React.JSX.Element | null {
  if (attachments.length === 0) return null;
  return (
    <div
      className="flex flex-wrap gap-1 px-3 pt-2"
      data-testid="attachment-bar"
    >
      {attachments.map((a, i) => (
        <Badge key={i} tone="neutral" className="gap-1.5 py-1 pr-1">
          <span className="max-w-[220px] truncate font-mono">{label(a)}</span>
          <button
            type="button"
            aria-label="Remove attachment"
            className="text-fg-3 hover:text-fg-1"
            onClick={() => onRemove(i)}
          >
            ×
          </button>
        </Badge>
      ))}
    </div>
  );
}
