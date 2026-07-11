// Checkbox with label — ported from components/core/Checkbox.jsx. Settings toggles that
// read as options, todo items.

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  className = '',
}: CheckboxProps): React.JSX.Element {
  return (
    <label
      className={`inline-flex items-center gap-2 text-base ${
        disabled
          ? 'cursor-not-allowed text-fg-disabled'
          : 'cursor-pointer text-fg-1'
      } ${className}`}
    >
      <span
        className={`box-border inline-flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded border transition-colors duration-fast ease-out ${
          checked
            ? 'border-accent bg-accent'
            : 'border-border-2 bg-surface-well'
        }`}
      >
        {checked ? (
          <svg
            width="9"
            height="9"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--accent-fg)"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : null}
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="absolute h-0 w-0 opacity-0"
      />
      {label}
    </label>
  );
}
