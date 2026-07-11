// Keycap — ported from components/core/Kbd.jsx. Shortcuts render as one <kbd> per
// character: <Kbd keys="⌘K" /> renders two keycaps.

export interface KbdProps {
  keys: string;
  className?: string;
}

export function Kbd({ keys, className = '' }: KbdProps): React.JSX.Element {
  const caps = Array.from(keys);
  return (
    <span className={`inline-flex gap-[3px] ${className}`}>
      {caps.map((k, i) => (
        <kbd
          key={i}
          className="box-border inline-block min-w-[14px] rounded-1 border border-b-2 border-border-2 bg-bg-4 px-[5px] py-px text-center font-mono text-xs text-fg-1"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}
