// Root React component (Phase 0): composes the app-wide providers around the 3-pane
// layout. The IPC-OK indicator is hosted inside AppLayout (left-rail footer) so it is
// always visible; App just wires providers → layout.

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
