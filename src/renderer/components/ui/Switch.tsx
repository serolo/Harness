// On/off switch — ported from components/core/Switch.jsx. Settings booleans
// (notifications, telemetry, auto-update).

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  className = '',
}: SwitchProps): React.JSX.Element {
  return (
    <label
      className={`inline-flex items-center gap-2 text-base ${
        disabled
          ? 'cursor-not-allowed text-fg-disabled'
          : 'cursor-pointer text-fg-1'
      } ${className}`}
    >
      <span
        role="switch"
        aria-checked={checked}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative box-border h-[18px] w-[30px] shrink-0 rounded-full border transition-colors duration-base ease-out ${
          checked ? 'border-accent bg-accent' : 'border-border-2 bg-bg-4'
        }`}
      >
        <span
          className="absolute top-[1.5px] h-[13px] w-[13px] rounded-full bg-white shadow-1 transition-[left] duration-base ease-out"
          style={{ left: checked ? 13 : 1.5 }}
        />
      </span>
      {label}
    </label>
  );
}
