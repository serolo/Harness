// AppContext — the single object holding every service singleton + the DB handle
// (the old "AppState", README §3 L85, §7.3). It is threaded to IPC registration
// (`registerIpc(ctx)`, Task 6) and passed to services that need siblings.
//
// THIS FILE DEFINES ONLY THE TYPE. Concrete construction (opening the DB, loading
// settings, instantiating each service, and assembling the object) happens in
// `src/main/index.ts` (Task 9) on `app.whenReady()`, and is NOT done here.
//
// All imports are TYPE-ONLY so that pulling `AppContext` into a module (e.g. the
// IPC layer) never drags native modules (better-sqlite3, node-pty) into that
// module's runtime graph — only their types. `AppDatabase` + `SettingsService`
// are imported type-only per the plan's Execution Strategy note.

import type { AppDatabase } from './db';
import type { SettingsService } from './settings';
import type { GitService } from './git';
import type { WorkspaceManager } from './workspace';
import type { HarnessSupervisor } from './harness/supervisor';
import type { TurnRecorder } from './harness/turns';
import type { PtyService } from './pty';
import type { ProcessRunner } from './process';
import type { DiffService } from './diff';
import type { CheckpointService } from './checkpoint';
import type { ChecksService } from './checks';
import type { IntegrationService } from './integrations';
import type { LinearService } from './integrations/linear';
import type { PrWorkflow } from './integrations/github/pr';
import type { OnboardingService } from './onboarding';
import type { UpdateService } from './update';

/**
 * Service singletons + the typed DB handle, shared across the main process.
 * Exactly the 11 fields the plan (Task 5) freezes; later phases add fields
 * additively (README §5.2), never reorder or remove.
 *
 * `process.registry` (the `ProcessRegistry` used for tree-kill on quit) is
 * reachable via `process.registry` on the `ProcessRunner` — it is not a separate
 * top-level field.
 */
export interface AppContext {
  /** Typed Kysely handle over better-sqlite3 (Task 4). */
  db: AppDatabase;
  /** Read-only layered settings (Task 7). */
  settings: SettingsService;
  /** Git worktree/diff/refs wrapper (Phase 1/4). */
  git: GitService;
  /** Workspace lifecycle + status machine owner (Phase 1). */
  workspaces: WorkspaceManager;
  /** Live agent processes + turn routing (Phase 2). */
  harness: HarnessSupervisor;
  /** Turn/event persistence + chat reconstruction (Phase 2). */
  recorder: TurnRecorder;
  /** node-pty terminals (Phase 3). */
  pty: PtyService;
  /** Named run/setup/archive scripts; `.registry` for tree-kill (Phase 3). */
  process: ProcessRunner;
  /** Diff computation + inline comments (Phase 4). */
  diff: DiffService;
  /** Per-turn worktree checkpoints (Phase 4). */
  checkpoint: CheckpointService;
  /** Merge-readiness aggregator (Phase 5). */
  checks: ChecksService;
  /** GitHub/Linear connectors (Phase 5/7). */
  integrations: IntegrationService;
  /** Linear connector: connect/list/disconnect, issue listing + write-back (Phase 7). */
  linear: LinearService;
  /** PR lifecycle: open/merge + prepare fix-review/fix-check turns (Phase 5). */
  prWorkflow: PrWorkflow;
  /** Onboarding readiness composer (harness / GitHub / projects) (Phase 6, spec §7). */
  onboarding: OnboardingService;
  /** Auto-update lifecycle (electron-updater; descoped/guarded) (Phase 6, README §6.5). */
  updater: UpdateService;
}
