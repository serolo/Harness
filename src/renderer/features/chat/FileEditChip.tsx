// A compact activity row for a file_edit AgentEvent. Links to the diff once the
// transcript exposes workspace navigation context.

import { FilePenLine } from 'lucide-react';
import { FileReferencePill } from './FileReferencePill';

export interface FileEditChipProps {
  path: string;
  op: 'create' | 'modify' | 'delete';
  onOpenFile?: (path: string) => void;
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
  onOpenFile,
}: FileEditChipProps): React.JSX.Element {
  return (
    <div
      className="flex min-h-8 min-w-0 items-center gap-2 rounded-2 px-1.5 text-base text-fg-2"
      data-testid="file-edit-chip"
      data-op={op}
    >
      <FilePenLine className={`h-4 w-4 shrink-0 ${OP_CLASS[op]}`} aria-hidden />
      <span className="shrink-0 font-medium text-fg-1">{OP_LABEL[op]}</span>
      <FileReferencePill path={path} onOpenFile={onOpenFile} />
    </div>
  );
}
