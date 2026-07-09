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
  create: 'text-emerald-400',
  modify: 'text-amber-300',
  delete: 'text-red-400',
};

export function FileEditChip({
  path,
  op,
}: FileEditChipProps): React.JSX.Element {
  return (
    <div
      className="my-1 inline-flex items-center gap-2 rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1 text-xs"
      data-testid="file-edit-chip"
      data-op={op}
    >
      <span className={OP_CLASS[op]}>●</span>
      <span className="font-mono text-slate-200">{path}</span>
      <span className="text-slate-500">{OP_LABEL[op]}</span>
    </div>
  );
}
