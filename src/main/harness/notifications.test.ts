import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EffectiveSettingsSchema } from '../settings/schema';
import type { SettingsService } from '../settings';

const { notificationShow } = vi.hoisted(() => ({
  notificationShow: vi.fn(),
}));

vi.mock('electron', () => ({
  Notification: class NotificationMock {
    static isSupported(): boolean {
      return true;
    }

    on(): void {}

    show(): void {
      notificationShow();
    }
  },
}));

import { NotificationService } from './notifications';

function settingsWith(
  notifications: Partial<
    ReturnType<typeof EffectiveSettingsSchema.parse>['notifications']
  >,
): SettingsService {
  const value = EffectiveSettingsSchema.parse({ notifications });
  return { get: () => value } as unknown as SettingsService;
}

describe('NotificationService completion sounds', () => {
  beforeEach(() => vi.clearAllMocks());

  it('plays the selected sound for a completed turn even when desktop notifications are off', () => {
    const playSound = vi.fn();
    const service = new NotificationService({
      settings: settingsWith({ enabled: false, completionSound: 'ping' }),
      playSound,
    });

    service.turnDone({
      workspaceId: 'w1',
      status: 'completed',
      reason: 'Turn complete',
    });

    expect(playSound).toHaveBeenCalledOnce();
    expect(playSound).toHaveBeenCalledWith('ping');
    expect(notificationShow).not.toHaveBeenCalled();
  });

  it('does not play for errors, interruptions, or the None setting', () => {
    const playSound = vi.fn();
    const service = new NotificationService({
      settings: settingsWith({ completionSound: 'none' }),
      playSound,
    });

    service.turnDone({
      workspaceId: 'w1',
      status: 'completed',
      reason: 'Turn complete',
    });
    service.turnDone({
      workspaceId: 'w1',
      status: 'error',
      reason: 'Turn failed',
    });
    service.turnDone({
      workspaceId: 'w1',
      status: 'interrupted',
      reason: 'Turn interrupted',
    });

    expect(playSound).not.toHaveBeenCalled();
  });
});
