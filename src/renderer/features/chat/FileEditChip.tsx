// A compact chip for a file_edit AgentEvent. Links to the diff once Phase 4 lands
// (SEAM: wire an onClick that opens the diff view for `path`).

export interface FileEditChipProps {
  path: string;
  op: 'create' | 'modify' | 'delete';
}

const OP_LABEL: Record<FileEditChipProps['op'], string> = {
  create: 'created',
  modify: 'modified',
  delete: 'deleted',
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
  return (
    <div
      className="my-1 inline-flex items-center gap-2 rounded-2 border border-border-1 bg-surface-card px-2 py-1 text-xs"
      data-testid="file-edit-chip"
      data-op={op}
    >
      <span className={OP_CLASS[op]}>●</span>
      <span className="font-mono text-fg-1">{path}</span>
      <span className="text-fg-3">{OP_LABEL[op]}</span>
    </div>
  );
}
