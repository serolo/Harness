// useSettings — the Settings feature's data hook (Phase 6, Track B).
//
// Bridges the Track-A settings IPC (`settings:getEffective` + `settings:getProvenance`
// + `settings:set`, and the `settings:changed` broadcast) to the panel. All main
// access funnels through `@renderer/ipc` (README §10) — never `window.api` directly.
//
// Writes target the USER layer: the project layers require an active-project→settings
// wiring that does not exist yet (main rejects them), and the user file is the global
// surface the panel edits. After a write we optimistically apply the returned effective
// value and refetch provenance (the write also fires `settings:changed`, but that is
// debounced and may lag — the round-trip keeps the UI immediate).

import { useCallback, useEffect, useState } from 'react';

import type {
  EffectiveSettings,
  SettingsIssue,
  SettingsProvenance,
} from '@shared/settings';
import { AppError } from '@shared/errors';
import { invoke, onEvent } from '@renderer/ipc';

export interface UseSettings {
  /** The effective (merged) settings, or null until the first load resolves. */
  effective: EffectiveSettings | null;
  /** Per-leaf provenance (which layer supplied each value). */
  provenance: SettingsProvenance;
  /**
   * Layer validation issues from the most recent non-throwing load (a bad TOML/zod
   * layer that was skipped). Empty when every layer parsed cleanly.
   */
  issues: SettingsIssue[];
  /** True until the initial load resolves. */
  loading: boolean;
  /** The last load/write error, if any. */
  error: AppError | null;
  /** Write one setting to the user layer, then refresh effective + provenance. */
  set: (keyPath: string, value: unknown) => Promise<void>;
}

/** Coerce an unknown rejection into an AppError (the ipc funnel already revives most). */
function toAppError(err: unknown, fallback: string): AppError {
  return err instanceof AppError
    ? err
    : new AppError('internal', fallback, err);
}

/**
 * Effective settings + provenance for the Settings panel. Loads both on mount,
 * refetches on every `settings:changed` broadcast (hot-reload / external edit), and
 * exposes `set` for write-to-(user)-layer edits. The `settings:changed` subscription
 * is torn down on unmount so it never leaks.
 */
export function useSettings(): UseSettings {
  const [effective, setEffective] = useState<EffectiveSettings | null>(null);
  const [provenance, setProvenance] = useState<SettingsProvenance>({});
  const [issues, setIssues] = useState<SettingsIssue[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<AppError | null>(null);

  const load = useCallback((): void => {
    Promise.all([
      invoke('settings:getEffective', undefined),
      invoke('settings:getProvenance', undefined),
      invoke('settings:getIssues', undefined),
    ])
      .then(([eff, prov, iss]) => {
        setEffective(eff);
        setProvenance(prov);
        // Defensive: the handler always returns an array, but a malformed response must
        // not crash the banner's `.map` — `issues` is the hook's array-typed contract.
        setIssues(Array.isArray(iss) ? iss : []);
        setError(null);
      })
      .catch((err: unknown) =>
        setError(toAppError(err, 'failed to load settings')),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    // Hot-reload: an external edit (or our own write) refreshes the snapshot.
    const unsubscribe = onEvent('settings:changed', () => load());
    return unsubscribe;
  }, [load]);

  const set = useCallback(
    async (keyPath: string, value: unknown): Promise<void> => {
      try {
        const eff = await invoke('settings:set', {
          layer: 'user',
          keyPath,
          value,
        });
        setEffective(eff);
        setProvenance(await invoke('settings:getProvenance', undefined));
        setError(null);
      } catch (err: unknown) {
        setError(toAppError(err, 'failed to save setting'));
        throw err;
      }
    },
    [],
  );

  return { effective, provenance, issues, loading, error, set };
}
