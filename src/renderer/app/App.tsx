// Root React component: composes the app-wide providers around the 3-pane layout.

import { Providers } from '@renderer/app/providers';
import { AppLayout } from '@renderer/app/AppLayout';

/** The application root rendered into `#root` by main.tsx. */
export function App(): React.JSX.Element {
  return (
    <Providers>
      <AppLayout />
    </Providers>
  );
}
