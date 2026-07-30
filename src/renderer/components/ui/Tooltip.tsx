import type { ReactNode } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

/** Shared hover/focus tooltip for compact icon and toolbar controls. */
export function Tooltip({
  content,
  children,
  side = 'top',
}: TooltipProps): React.JSX.Element {
  return (
    <TooltipPrimitive.Provider delayDuration={350} skipDelayDuration={100}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          <span className="inline-flex min-w-0 max-w-full">{children}</span>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={7}
            className="z-[1200] rounded-2 border border-border-1 bg-surface-overlay px-2 py-1 text-xs font-medium text-fg-1 shadow-3"
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
