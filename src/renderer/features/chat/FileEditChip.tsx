// A compact activity row for a file_edit AgentEvent. Links to the diff once the
// transcript exposes workspace navigation context.

import { FilePenLine } from 'lucide-react';

export interface FileEditChipProps {
  path: string;
  op: 'create' | 'modify' | 'delete';
}

const OP_LABEL: Record<FileEditChipProps['op'], string> = {
  create: 'Write file',
  modify: 'Edit file',
  delete: 'Delete file',
};

const OP_CLASS: Record<FileEditChipProps['op'], string> = {
  create: 'text-ok',
  modify: 'text-warn',
  delete: 'text-danger',
};

export function FileEditChip({
  path,
  op,
}: FileEditChipProps): React.JSX.Element {
  const fileName = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

  return (
    <div
      className="flex min-h-8 min-w-0 items-center gap-2 rounded-2 px-1.5 text-base text-fg-2"
      data-testid="file-edit-chip"
      data-op={op}
    >
      <FilePenLine className={`h-4 w-4 shrink-0 ${OP_CLASS[op]}`} aria-hidden />
      <span className="shrink-0 font-medium text-fg-1">{OP_LABEL[op]}</span>
      <code
        className="min-w-0 truncate rounded-1 border border-border-2 bg-bg-3 px-2 py-0.5 font-mono text-sm text-fg-2"
        title={path}
      >
        {fileName}
      </code>
    </div>
  );
}
