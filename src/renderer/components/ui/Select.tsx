// Native select styled to match Input — ported from components/core/Select.jsx.

import type { SelectHTMLAttributes } from 'react';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'children'
> {
  options: SelectOption[];
}

const CHEVRON_BG =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238b93a7' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")";

export function Select({
  options,
  className = '',
  style,
  ...rest
}: SelectProps): React.JSX.Element {
  return (
    <select
      className={`h-control box-border cursor-pointer appearance-none rounded-2 border border-border-2 bg-surface-well py-0 pl-2.5 pr-[26px] font-ui text-sm text-fg-1 ${className}`}
      style={{
        backgroundImage: CHEVRON_BG,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 8px center',
        ...style,
      }}
      {...rest}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
