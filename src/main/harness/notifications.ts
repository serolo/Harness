// NotificationService (spec §5.8, phase-doc §3.7) — native Electron notifications on
// turn completion / errors, with click-through to the workspace deep link. Main-only
// (`Notification` is a main-process API). Best-effort: a platform without notification
// support must NEVER throw into the turn path.
//
// SECURITY (heightened-scrutiny — secrets): the notification body is limited to the
// workspace name + a short reason. It NEVER includes prompt text or tool output, which
// can carry secrets.

import { Notification } from 'electron';
import type { TurnStatus } from '@shared/models';
import type { SettingsService } from '../settings';
import { logger } from '../logging';

/** Deep-link scheme (matches `src/main/index.ts`). */
const DEEP_LINK_SCHEME = 'harness';

export interface TurnDoneInfo {
  workspaceId: string;
  /** Human-friendly workspace name for the toast title (no secrets). */
  workspaceName?: string;
  status: TurnStatus;
  reason: string;
}

export interface NotificationServiceDeps {
  settings: SettingsService;
  /** Route a clicked deep link (reuse `index.ts`'s handler). Optional in tests. */
  onDeepLink?: (url: string) => void;
}

export class NotificationService {
  private readonly settings: SettingsService;
  private readonly onDeepLink?: (url: string) => void;

  constructor(deps: NotificationServiceDeps) {
    this.settings = deps.settings;
    this.onDeepLink = deps.onDeepLink;
  }

  /**
   * Fire a native notification for a finished turn, respecting the `[notifications]`
   * settings toggles. `interrupted` turns are user-initiated, so they never notify.
   * All failures are swallowed (best-effort) so notifications can't break a turn.
   */
  turnDone(info: TurnDoneInfo): void {
    try {
      const s = this.settings.get().notifications;
      if (!s.enabled) return;
      if (info.status === 'interrupted') return; // user asked for it — no toast
      if (info.status === 'error' && !s.onError) return;
      if (info.status === 'completed' && !s.onTurnComplete) return;
      if (!s.onNeedsAttention) return; // the umbrella "attention" toggle

      if (!Notification.isSupported()) {
        return;
      }

      const title = info.workspaceName
        ? `${info.workspaceName} — ${statusLabel(info.status)}`
        : statusLabel(info.status);

      const notification = new Notification({ title, body: info.reason });
      notification.on('click', () => {
        this.onDeepLink?.(
          `${DEEP_LINK_SCHEME}://workspace/${info.workspaceId}`,
        );
      });
      notification.show();
    } catch (err) {
      logger.warn(
        `[notifications] failed to show turn notification: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/** Short, secret-free label for a turn status. */
function statusLabel(status: TurnStatus): string {
  switch (status) {
    case 'completed':
      return 'Turn complete';
    case 'error':
      return 'Turn failed';
    case 'interrupted':
      return 'Turn interrupted';
    case 'streaming':
      return 'Working…';
    default:
      return 'Turn update';
  }
}
