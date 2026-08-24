// Root React component: composes the app-wide providers around the 3-pane layout.

import { useEffect } from 'react';

import { Providers } from '@renderer/app/providers';
import { AppLayout } from '@renderer/app/AppLayout';
import { OnboardingWizard } from '@renderer/features/onboarding/OnboardingWizard';
import { initializeRendererCrashReporting } from '@renderer/telemetry';

/** The application root rendered into `#root` by main.tsx. */
export function App(): React.JSX.Element {
  useEffect(() => {
    void initializeRendererCrashReporting().catch(() => {
      // Reporting must never affect app startup.
    });
  }, []);

  return (
    <Providers>
      <AppLayout />
      <OnboardingWizard />
    </Providers>
  );
}
