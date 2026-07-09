// App-wide providers (Phase 0): TanStack Query + a light theme context + Radix's
// Tooltip provider.
//
// - QueryClientProvider: one QueryClient for the app. Phase 0 issues no queries, but the
//   provider is in place so later phases (command results, caching/invalidation) can use
//   `useQuery`/`useMutation` without re-plumbing the root.
// - ThemeContext: publishes the tokens from `theme.ts` so components can read them. Kept
//   deliberately light — no runtime theme switching in Phase 0.
// - Tooltip.Provider (Radix): a single provider at the root is the recommended Radix
//   pattern and also proves the Radix primitive import is wired end-to-end.

import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { theme as defaultTheme } from '@renderer/app/theme';
import type { Theme } from '@renderer/app/theme';

/** React context carrying the active theme tokens. */
const ThemeContext = createContext<Theme>(defaultTheme);

/** Read the active theme tokens (colors/spacing). */
export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/**
 * Factory for the app's QueryClient. Extracted so tests can build an isolated client
 * (with retries off) rather than sharing the app singleton.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Command results are explicitly invalidated by mutations/events, so avoid
        // background refetch churn in a desktop app.
        refetchOnWindowFocus: false,
      },
    },
  });
}

/** Props for the root provider tree. */
export interface ProvidersProps {
  children: ReactNode;
}

/** Wraps the app in the Query, Theme, and Tooltip providers. */
export function Providers({ children }: ProvidersProps): React.JSX.Element {
  // One client for the lifetime of the app; `useState` initializer guarantees it is
  // created once (not on every render).
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeContext.Provider value={defaultTheme}>
        <Tooltip.Provider delayDuration={300}>{children}</Tooltip.Provider>
      </ThemeContext.Provider>
    </QueryClientProvider>
  );
}
