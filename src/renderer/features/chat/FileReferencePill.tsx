function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function extension(path: string): string {
  const name = fileName(path);
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  return match ? match[1].toUpperCase() : 'FILE';
}

function badgeClass(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'ts':
    case 'tsx':
      return 'border-[#2563eb]/70 bg-[#1d4ed8] text-white';
    case 'js':
    case 'jsx':
      return 'border-[#facc15]/70 bg-[#facc15] text-black';
    case 'json':
      return 'border-[#22c55e]/60 bg-[#14532d] text-[#bbf7d0]';
    case 'css':
    case 'scss':
      return 'border-[#38bdf8]/70 bg-[#075985] text-[#e0f2fe]';
    case 'md':
    case 'mdx':
      return 'border-border-2 bg-bg-4 text-fg-2';
    default:
      return 'border-border-2 bg-bg-4 text-fg-2';
  }
}

export function FileReferencePill({
  path,
  label,
  onOpenFile,
  actionLabel,
}: {
  path: string;
  label?: string;
  onOpenFile?: (path: string) => void;
  actionLabel?: string;
}): React.JSX.Element {
  const ext = extension(path);
  const content = (
    <>
      <span
        className={`inline-flex h-5 shrink-0 items-center rounded-1 border px-1 font-mono text-[11px] font-semibold leading-none ${badgeClass(
          ext,
        )}`}
        aria-hidden="true"
      >
        {ext}
      </span>
      <span className="min-w-0 truncate font-medium">
        {label ?? fileName(path)}
      </span>
    </>
  );

  if (!onOpenFile) {
    return (
      <span
        className="inline-flex max-w-72 items-center gap-1.5 rounded-2 border border-border-2 bg-bg-3 px-2 py-1 text-sm text-fg-1"
        title={`Open ${path}`}
      >
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="inline-flex max-w-72 items-center gap-1.5 rounded-2 border border-border-2 bg-bg-3 px-2 py-1 text-sm text-fg-1 transition-colors hover:border-accent hover:bg-bg-4"
      title={actionLabel ?? `Open ${path}`}
      aria-label={actionLabel ?? `Open ${path}`}
      onClick={() => onOpenFile(path)}
    >
      {content}
    </button>
  );
}
