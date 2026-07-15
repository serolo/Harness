// App-wide providers (Phase 0): TanStack Query + theme context + Radix's
// Tooltip provider.
//
// - QueryClientProvider: one QueryClient for the app. Phase 0 issues no queries, but the
//   provider is in place so later phases (command results, caching/invalidation) can use
//   `useQuery`/`useMutation` without re-plumbing the root.
// - ThemeContext: publishes the tokens from `theme.ts` so components can read them.
// - Tooltip.Provider (Radix): a single provider at the root is the recommended Radix
//   pattern and also proves the Radix primitive import is wired end-to-end.

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { theme as defaultTheme, themes } from '@renderer/app/theme';
import type { Theme } from '@renderer/app/theme';
import { isAppearanceTheme } from '@shared/settings';
import { invoke, onEvent } from '@renderer/ipc';

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
  const [theme, setTheme] = useState<Theme>(defaultTheme);

  const applyTheme = useCallback((next: unknown): void => {
    const appearance = isAppearanceTheme(next) ? next : 'dark';
    document.documentElement.dataset.theme =
      appearance === 'light' ? 'light' : 'dark';
    setTheme(themes[appearance]);
  }, []);

  const loadTheme = useCallback((): void => {
    void invoke('settings:getEffective', undefined)
      .then((settings) => applyTheme(settings.appearance?.theme))
      .catch(() => applyTheme('dark'));
  }, [applyTheme]);

  useEffect(() => {
    loadTheme();
    const unsubscribe = onEvent('settings:changed', () => loadTheme());
    return unsubscribe;
  }, [loadTheme]);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeContext.Provider value={theme}>
        <Tooltip.Provider delayDuration={300}>{children}</Tooltip.Provider>
      </ThemeContext.Provider>
    </QueryClientProvider>
  );
}
