import { useCallback, useEffect, useRef, useState } from 'react';

import type { UpdateStatus } from '@shared/ipc';
import { invoke, onEvent } from '@renderer/ipc';

let automaticDownloadedModalShown = false;

export interface AppUpdateController {
  status: UpdateStatus;
  open: boolean;
  installing: boolean;
  manualCheck: () => Promise<void>;
  close: () => void;
  install: () => Promise<void>;
}

/**
 * Owns the global update snapshot and modal visibility. The event subscription is
 * installed before hydration; an event sequence guard prevents a late snapshot response
 * from overwriting a newer broadcast.
 */
export function useAppUpdate(): AppUpdateController {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' });
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const installingRef = useRef(false);
  const manualRef = useRef(false);
  const eventSequenceRef = useRef(0);

  const applyStatus = useCallback((next: UpdateStatus): void => {
    setStatus({ ...next });
    if (manualRef.current) {
      setOpen(true);
    }
    if (next.state === 'downloaded' && !automaticDownloadedModalShown) {
      automaticDownloadedModalShown = true;
      setOpen(true);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const unsubscribe = onEvent('update:status', (next) => {
      if (!active) return;
      eventSequenceRef.current += 1;
      applyStatus(next);
    });
    const sequenceBeforeHydration = eventSequenceRef.current;
    void invoke('update:getStatus', undefined)
      .then((snapshot) => {
        if (active && eventSequenceRef.current === sequenceBeforeHydration) {
          applyStatus(snapshot);
        }
      })
      .catch(() => {
        // Automatic hydration failures stay silent. A manual check remains recoverable.
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [applyStatus]);

  const manualCheck = useCallback(async (): Promise<void> => {
    manualRef.current = true;
    setOpen(true);
    setStatus((current) => ({
      state: 'checking',
      ...(current.currentVersion === undefined
        ? {}
        : { currentVersion: current.currentVersion }),
    }));
    try {
      applyStatus(await invoke('update:check', undefined));
    } catch {
      applyStatus({
        state: 'error',
        message: 'Unable to check for updates. Please try again later.',
      });
    }
  }, [applyStatus]);

  const close = useCallback((): void => {
    manualRef.current = false;
    setOpen(false);
  }, []);

  const install = useCallback(async (): Promise<void> => {
    if (status.state !== 'downloaded' || installingRef.current) return;
    installingRef.current = true;
    setInstalling(true);
    try {
      await invoke('update:install', undefined);
    } catch {
      installingRef.current = false;
      setInstalling(false);
      manualRef.current = true;
      applyStatus({
        state: 'error',
        message: 'Unable to restart and install the update. Please try again.',
        currentVersion: status.currentVersion,
        version: status.version,
      });
    }
  }, [applyStatus, status]);

  return { status, open, installing, manualCheck, close, install };
}
