import { useEffect, useState } from 'react';
import type { Attachment } from '@shared/harness';
import { invoke } from '@renderer/ipc';

interface UserAttachmentsProps {
  workspaceId?: string | null;
  turnId: string;
  attachments: Attachment[];
}

function attachmentName(attachment: Attachment): string {
  if (attachment.type === 'diff_comment') {
    return `${attachment.file}:${attachment.lineStart}${
      attachment.lineEnd === attachment.lineStart
        ? ''
        : `-${attachment.lineEnd}`
    }`;
  }
  return attachment.path.split(/[\\/]/).at(-1) || 'Attachment';
}

function ImageAttachment({
  workspaceId,
  turnId,
  attachmentIndex,
  name,
}: {
  workspaceId?: string | null;
  turnId: string;
  attachmentIndex: number;
  name: string;
}): React.JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    setDataUrl(null);
    if (!workspaceId || turnId.startsWith('pending:')) return;
    let active = true;
    void invoke('attachment:imagePreview', {
      workspaceId,
      turnId,
      attachmentIndex,
    })
      .then((result) => {
        if (active) setDataUrl(result.dataUrl);
      })
      .catch(() => {
        // Keep the safe filename fallback when the local file is unavailable.
      });
    return () => {
      active = false;
    };
  }, [attachmentIndex, turnId, workspaceId]);

  return (
    <figure className="overflow-hidden rounded-xl border border-border bg-surface-1">
      {dataUrl ? (
        <img
          src={dataUrl}
          alt={name}
          className="max-h-80 w-auto max-w-full object-contain"
          data-testid="chat-user-image"
        />
      ) : null}
      <figcaption className="max-w-[28rem] truncate px-3 py-2 text-xs text-fg-2">
        {name}
      </figcaption>
    </figure>
  );
}

export function UserAttachments({
  workspaceId,
  turnId,
  attachments,
}: UserAttachmentsProps): React.JSX.Element {
  return (
    <div className="flex justify-end" data-testid="chat-user-attachments">
      <div className="flex max-w-[82%] flex-wrap justify-end gap-2">
        {attachments.map((attachment, index) => {
          const name = attachmentName(attachment);
          if (attachment.type === 'image') {
            return (
              <ImageAttachment
                key={`${attachment.type}:${attachment.path}:${index}`}
                workspaceId={workspaceId}
                turnId={turnId}
                attachmentIndex={index}
                name={name}
              />
            );
          }
          return (
            <span
              key={`${attachment.type}:${name}:${index}`}
              className="max-w-[28rem] truncate rounded-lg border border-border bg-surface-1 px-3 py-2 text-xs text-fg-2"
            >
              {name}
            </span>
          );
        })}
      </div>
    </div>
  );
}
