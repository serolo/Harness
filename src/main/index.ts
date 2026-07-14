// Main-process entry + CONVERGENCE point (Task 9, README §3 L84–91).
//
// This is the single place that:
//   1. initializes electron-log FIRST (so even pre-ready failures are captured);
//   2. on `app.whenReady()`, opens the DB (runs migrations synchronously), loads
//      settings, instantiates EVERY subsystem stub, assembles the one concrete
//      `AppContext`, and calls `registerIpc(ctx)`;
//   3. creates a HARDENED `BrowserWindow` (contextIsolation + nodeIntegration:false
//      + sandbox + webSecurity + strict CSP) — README §7.6, NON-NEGOTIABLE;
//   4. wires the `harness://` deep link (log-only for now — nav is Phase 5+);
//   5. installs a `before-quit` teardown scaffold (no tree-kill yet — Phase 3).
//
// SECURITY (README §7.6, get-it-right-once): the renderer reaches main ONLY through
// the preload `window.api`. No Node integration, no `ipcRenderer`, no remote content.
// `better-sqlite3` loads in THIS (main) process only — never the sandboxed renderer.

import { join } from 'node:path';

import {
  app,
  BrowserWindow,
  Menu,
  session,
  type MenuItemConstructorOptions,
  type OnHeadersReceivedListenerDetails,
  type HeadersReceivedResponse,
} from 'electron';

import { openDb } from './db';
import { SettingsService } from './settings';
import { GitService } from './git';
import { WorkspaceManager } from './workspace';
import { HarnessSupervisor } from './harness/supervisor';
import { TurnRecorder } from './harness/turns';
import { TurnsRepo } from './db/repos/turns';
import { EventsRepo } from './db/repos/events';
import { NotificationService } from './harness/notifications';
import { ClaudeCodeHarness } from './harness/claude-code';
import { CodexHarness } from './harness/codex';
import { CursorHarness } from './harness/cursor';
import type { RawPtySpawner } from './harness/raw-terminal';
import { MockHarness } from './harness/mock';
import type { Harness } from '@shared/harness';
import { PtyService } from './pty';
import { ProcessRegistry, ProcessRunner } from './process';
import { DiffService } from './diff';
import { DiffCommentsRepo } from './db/repos/comments';
import { CheckpointService } from './checkpoint';
import { CheckpointsRepo } from './db/repos/checkpoints';
import { TodosRepo } from './db/repos/todos';
import { ChecksService } from './checks';
import { IntegrationService } from './integrations';
import { LinearService } from './integrations/linear';
import { OnboardingService } from './onboarding';
import { UpdateService } from './update';
import { SecretStore } from './integrations/secrets';
import { PrWorkflow } from './integrations/github/pr';
import { IntegrationsRepo } from './db/repos/integrations';
import { ProjectsRepo } from './db/repos/projects';
import { WorkspacesRepo } from './db/repos/workspaces';
import * as naming from './workspace/naming';
import * as ports from './workspace/ports';
import { runSetup } from './workspace/setup';
import { emitAll } from './ipc/events';
import type { EventChannel, EventPayload } from '@shared/ipc';
import type { AppContext } from './context';
import { registerIpc, focusRefreshWorkspaceIds } from './ipc/register';
import { resolveDeepLink } from './deeplink';
import {
  NATIVE_VIEW_ROLES,
  resolveShortcuts,
  type ShortcutAction,
} from './shortcuts';
import { initLogging } from './logging';

// --- Constants -------------------------------------------------------------

/** Deep-link scheme (spec §5.8, `harness://workspace/<id>`). Also drives appId/Keychain. */
const DEEP_LINK_SCHEME = 'harness';

/** Initial window geometry — placeholder; real persistence is a later phase. */
const WINDOW_DEFAULTS = {
  width: 1440,
  height: 900,
  minWidth: 960,
  minHeight: 600,
  // macOS only: inset the native traffic lights into the renderer's custom titlebar
  // strip (Harness design system) instead of drawing a full native title bar. Real
  // OS-drawn traffic lights, not a renderer-painted substitute. Other platforms keep
  // the default frame — no custom titlebar there.
  ...(process.platform === 'darwin'
    ? {
        titleBarStyle: 'hiddenInset' as const,
        trafficLightPosition: { x: 14, y: 13 },
      }
    : {}),
};

// electron-log is the process-wide logger; init it before anything else can fail.
const logger = initLogging();

/**
 * The assembled AppContext, held at module scope so the `before-quit` handler (which
 * is registered outside `whenReady`) can reach the harness supervisor for teardown.
 */
let appContext: AppContext | undefined;

/**
 * electron-vite sets `ELECTRON_RENDERER_URL` to the dev-server address ONLY while
 * running under `electron-vite dev`. Its presence is the canonical dev signal (the
 * `@electron-toolkit/utils` `is.dev` helper checks exactly this). In a packaged /
 * built run the var is absent and we load the built `index.html` from disk.
 *
 * Read once at module load; `process.env` is stable for the process lifetime.
 */
const rendererDevUrl = process.env['ELECTRON_RENDERER_URL'];
const isDev = rendererDevUrl !== undefined && rendererDevUrl !== '';

// --- Content-Security-Policy ----------------------------------------------

/**
 * Build the CSP header value. The policy forbids ALL remote content; the only
 * dev-vs-prod difference is the relaxations Vite's HMR runtime requires:
 *
 *   - dev: the renderer is served from the Vite dev server over http + a `ws:`
 *     socket for HMR, and Vite injects inline `<script>`/`<style>` for fast
 *     refresh — so `script-src`/`style-src` need `'unsafe-inline'` and
 *     `connect-src` must allow the dev origin + its websocket.
 *   - prod: everything is bundled and served from the `file:` origin, so we lock
 *     it down to `'self'` (plus `'unsafe-inline'` for styles only, which Tailwind
 *     / Radix inject at runtime — matching index.html's baseline meta CSP).
 *
 * `object-src 'none'` + `base-uri 'self'` + `frame-ancestors 'none'` are always on:
 * no plugins, no `<base>` hijack, no embedding of the app in a frame.
 */
function buildCsp(): string {
  const common = [
    "default-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "font-src 'self' data:",
  ];

  if (isDev) {
    // Derive the dev origin (http) + its ws origin from the Vite URL so the CSP
    // tracks whatever host/port electron-vite chose, rather than hardcoding it.
    const devOrigin = originOf(rendererDevUrl) ?? "'self'";
    const wsOrigin = devOrigin.replace(/^http/, 'ws');
    return [
      ...common,
      // Vite's HMR client + React Fast Refresh inject inline scripts in dev.
      `script-src 'self' 'unsafe-inline' ${devOrigin}`,
      `style-src 'self' 'unsafe-inline' ${devOrigin}`,
      `connect-src 'self' ${devOrigin} ${wsOrigin}`,
    ].join('; ');
  }

  // Production: no inline scripts, no remote anything. Styles keep 'unsafe-inline'
  // because Tailwind/Radix inject stylesheets at runtime (see index.html meta CSP).
  return [
    ...common,
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
  ].join('; ');
}

/** Extract the `scheme://host:port` origin from a URL, or `undefined` if unparseable. */
function originOf(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Attach the CSP to every response on the default session. Using the response
 * header (rather than only the `<meta>` in index.html) is the authoritative,
 * main-controlled path README §7.6 prefers — it also covers responses the meta tag
 * cannot (e.g. the dev-server documents).
 */
function installCsp(): void {
  const csp = buildCsp();
  session.defaultSession.webRequest.onHeadersReceived(
    (
      details: OnHeadersReceivedListenerDetails,
      callback: (response: HeadersReceivedResponse) => void,
    ) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [csp],
        },
      });
    },
  );
}

// --- AppContext assembly (the ONE place it is constructed) ------------------

/**
 * Open the DB (runs migrations synchronously — completes BEFORE any window can call
 * DB-backed IPC), load settings, instantiate every subsystem stub, and assemble the
 * concrete `AppContext`. This is the single construction site for the 11-field
 * context type defined in `context.ts`.
 *
 * Phase 1 wires the real `WorkspaceManager`: it receives the db-backed repos, the
 * stateless `GitService`, the pure name/port allocators, the read-only settings, the
 * setup-command runner, a process-stop hook (a Phase-3 no-op), and a broadcast `emit`
 * closure over every open window. `ProcessRunner` requires a `ProcessRegistry` (its
 * only constructor arg); every remaining subsystem is still a no-arg Phase-0 stub.
 * Later phases inject their own collaborators here.
 */
function createAppContext(): AppContext {
  // openDb() → default path via paths.dbPath(); pragmas (WAL, FK) + migrations run
  // synchronously inside openDb, so by the time it returns the schema is current.
  const db = openDb();
  logger.info('[startup] database opened + migrations applied');

  const settings = new SettingsService();
  settings.load();
  logger.info('[startup] settings loaded');

  // Phase 1: repos + git + allocators + broadcast emitter, injected into the manager.
  const projectsRepo = new ProjectsRepo(db);
  const workspacesRepo = new WorkspacesRepo(db);
  const git = new GitService();

  // Broadcast an event to every open window (destroyed WebContents are skipped in emitAll).
  const emit = <K extends EventChannel>(
    event: K,
    payload: EventPayload<K>,
  ): void => {
    emitAll(
      BrowserWindow.getAllWindows().map((w) => w.webContents),
      event,
      payload,
    );
  };

  // Phase 6: hot-reload — re-merge on external edits to a settings layer file and
  // broadcast `settings:changed` so open renderers refetch. Handlers already read
  // `ctx.settings.get()` fresh, so this only refreshes the snapshot + notifies; an
  // in-flight turn keeps the settings it snapshotted at start. Stopped in before-quit.
  settings.watch(() => emit('settings:changed', {}));

  // ProcessRegistry is shared: the runner owns it (`.registry`) and PtyService registers
  // its children into the SAME one, so archive + quit tree-kill runs AND terminals.
  const processRegistry = new ProcessRegistry();

  // Phase 3: tree-kill the workspace's process group BEFORE its worktree is force-removed
  // (archive) — routes the Phase-1 stop hook through the shared registry.
  const stopWorkspaceProcesses = (id: string): Promise<void> =>
    processRegistry.stopWorkspace(id);

  const workspaces = new WorkspaceManager({
    repos: { projects: projectsRepo, workspaces: workspacesRepo },
    git,
    naming,
    ports,
    settings,
    runSetup,
    stopWorkspaceProcesses,
    emit,
  });

  // Phase 2: turn/event persistence + recorder (coalescing write path). The TurnsRepo
  // is shared with CheckpointService (revert marks later turns reverted).
  const turnsRepo = new TurnsRepo(db);
  const recorder = new TurnRecorder({
    turns: turnsRepo,
    events: new EventsRepo(db),
  });

  // Phase 4: diff computation + inline comments, and per-turn worktree checkpoints.
  // Constructed BEFORE the supervisor so the turn-end hook (Task 8) can snapshot a
  // checkpoint + recompute the diff off the finalize path.
  const diff = new DiffService({
    git,
    getWorkspace: (id) => workspaces.get(id),
    emit,
    comments: new DiffCommentsRepo(db),
  });
  const checkpoint = new CheckpointService({
    git,
    getWorkspace: (id) => workspaces.get(id),
    checkpoints: new CheckpointsRepo(db),
    turns: turnsRepo,
  });
  const todos = new TodosRepo(db);

  // Native turn notifications; clicks route the workspace deep link (log-only nav).
  const notifications = new NotificationService({
    settings,
    onDeepLink: handleDeepLink,
  });

  // Phase 5: GitHub integration + merge-readiness checks + PR lifecycle. Constructed
  // BEFORE the harness so the turn-end hook can recompute checks off the finalize path.
  //   - integrations: OAuth device-flow / PAT connect; tokens encrypted at rest via
  //     SecretStore (DB holds only a tokenRef). Device flow needs a client id (env).
  //   - checks: aggregates git + PR/CI/deploy/review + todo signals; failing CI raises
  //     needs_attention via the SAME setStatus + `notify:needsAttention` seam the harness
  //     uses for a finished turn (best-effort).
  //   - prWorkflow: open/merge a PR + compose fix-review/fix-check turns.
  // Shared across the GitHub + Linear connectors: one integrations repo (rows carry a
  // `kind` discriminator) and one SecretStore (token-at-rest under userData/secrets).
  const secrets = new SecretStore();
  const integrationsRepo = new IntegrationsRepo(db);
  const integrations = new IntegrationService({
    repo: integrationsRepo,
    secrets,
    clientId: process.env['AGENTAPP_GITHUB_CLIENT_ID'],
  });
  // Phase 7: Linear connector (API-key connect + GraphQL issue listing / write-back).
  const linear = new LinearService({ repo: integrationsRepo, secrets });
  const checks = new ChecksService({
    git,
    getWorkspace: (id) => workspacesRepo.getById(id),
    getProject: (id) => projectsRepo.getById(id),
    integrations,
    todos,
    emit,
    setNeedsAttention: async (workspaceId, reason) => {
      await workspaces.setStatus(workspaceId, 'needs_attention');
      emit('notify:needsAttention', { workspaceId, reason });
    },
  });
  const prWorkflow = new PrWorkflow({
    git,
    integrations,
    checks,
    workspaces: workspacesRepo,
    getWorkspace: (id) => workspacesRepo.getById(id),
    getProject: (id) => projectsRepo.getById(id),
    settings,
    diff,
  });

  // The harness supervisor owns live turns + drives status through the turn lifecycle.
  // Phase 4 wires two best-effort hooks: persist the agent's todo set on each
  // `todo_update`, and — after a turn finalizes — snapshot a checkpoint, recompute the
  // diff, and reconcile inline comments. Every hook is fire-and-forget with its own
  // error handling so a checkpoint/diff/todo failure can never wedge a turn.
  const harness = new HarnessSupervisor({
    recorder,
    getWorkspace: (id) => workspaces.get(id),
    setStatus: (id, status) => workspaces.setStatus(id, status),
    emit,
    notifications,
    onTodoUpdate: (workspaceId, todoList) => {
      void todos.replaceAgentTodos(workspaceId, todoList).catch((err) => {
        logger.error(
          `[turn-end] persisting agent todos for ${workspaceId} failed: ${String(err)}`,
        );
      });
    },
    onTurnEnd: (workspaceId, turnId) => {
      void (async () => {
        // Snapshot the worktree under refs/checkpoints/<ws>/<idx> (best-effort).
        try {
          await checkpoint.snapshot(workspaceId, turnId);
        } catch (err) {
          logger.error(
            `[turn-end] checkpoint snapshot for ${workspaceId} failed: ${String(err)}`,
          );
        }
        // Recompute the diff + notify the renderer, then reconcile sent comments.
        diff.invalidate(workspaceId);
        emit('diff:changed', { workspaceId });
        try {
          await diff.reconcileComments(workspaceId);
        } catch (err) {
          logger.error(
            `[turn-end] comment reconcile for ${workspaceId} failed: ${String(err)}`,
          );
        }
        // Phase 5: recompute merge-readiness checks now the tree/diff changed (the same
        // trigger point as `diff:changed`). Best-effort — a checks failure (e.g. no
        // GitHub account) must never wedge the turn-end hook.
        try {
          await checks.refresh(workspaceId);
        } catch (err) {
          logger.error(
            `[turn-end] checks refresh for ${workspaceId} failed: ${String(err)}`,
          );
        }
      })();
    },
  });

  // Register the harness backing the frozen `claude_code` id (D2): the real CLI
  // adapter, or the scripted MockHarness when settings/env select it. `AGENTAPP_E2E`
  // always forces the mock so CI/E2E never depend on an installed `claude`.
  const useMock =
    settings.get().agent.harnessImpl === 'mock' ||
    process.env['AGENTAPP_MOCK_HARNESS'] === '1' ||
    process.env['AGENTAPP_E2E'] === '1';
  const adapter: Harness = useMock
    ? new MockHarness()
    : new ClaudeCodeHarness();
  harness.register(adapter);
  logger.info(
    `[startup] harness registered: ${adapter.id} (${useMock ? 'mock' : 'claude-code'})`,
  );

  // The shared PTY service; also adapts to the raw-terminal harness spawner (Phase 7).
  const pty = new PtyService(processRegistry);

  // Phase 7: register the additional real agent CLIs (Codex, Cursor). Skipped under the
  // mock (E2E/CI never depend on an installed CLI). Registration does NOT spawn — a
  // `detect()` only runs when the renderer lists harnesses or a turn starts, and degrades
  // gracefully when the CLI is absent. Cursor has no structured JSON stream, so it runs
  // through the raw-terminal fallback: `PtyService.spawnRaw` structurally satisfies the
  // injected `RawPtySpawner` (it surfaces the exit code the transcript needs), so it is
  // passed straight in with no adapter glue. Teardown of a raw Cursor turn goes through
  // the supervisor's `quitAll`→`interrupt`→`kill` path, same as the other adapters.
  if (!useMock) {
    const rawPtySpawner: RawPtySpawner = {
      spawn: (options) => pty.spawnRaw(options),
    };
    harness.register(new CodexHarness());
    harness.register(new CursorHarness(rawPtySpawner));
    logger.info('[startup] harness registered: codex, cursor (Phase 7)');
  }

  // Phase 6: onboarding readiness composer (harness / GitHub / projects) for the first-run
  // wizard (spec §7). Reads existing signals only — no new persistence.
  const onboarding = new OnboardingService({
    listHarnesses: () => harness.listHarnesses(),
    countGithubAccounts: async () => (await integrations.list('github')).length,
    countProjects: async () => (await projectsRepo.list()).length,
  });

  // Phase 6: auto-update (README §6.5). DESCOPED for this checkout — there is no release
  // feed and no code-signing/notarization, so `feedConfigured` is false and no
  // `autoUpdater` is injected: the service reports `unsupported` and never touches
  // electron-updater (see src/main/update). When a signed build with a publish feed lands,
  // set `feedConfigured` (e.g. from `AGENTAPP_UPDATE_FEED`) and inject
  // `require('electron-updater').autoUpdater` here — the service already drives the full
  // check/download/install lifecycle from that injection.
  const updater = new UpdateService({
    isPackaged: app.isPackaged,
    feedConfigured: process.env['AGENTAPP_UPDATE_FEED'] !== undefined,
    autoUpdater: undefined,
    log: (message) => logger.info(message),
  });

  const ctx: AppContext = {
    db,
    settings,
    git,
    workspaces,
    harness,
    recorder,
    pty,
    process: new ProcessRunner(
      processRegistry,
      (id, status) => workspaces.setStatus(id, status),
      async (id) => (await workspaces.get(id))?.status ?? null,
    ),
    diff,
    checkpoint,
    checks,
    integrations,
    linear,
    prWorkflow,
    onboarding,
    updater,
  };

  return ctx;
}

// --- Window ----------------------------------------------------------------

/**
 * Create the hardened main window. `webPreferences` here are the get-it-right-once
 * security decisions (README §7.6) — do not relax them:
 *   - contextIsolation: true   — renderer + preload run in separate JS worlds.
 *   - nodeIntegration:  false  — no Node globals (`require`/`process`) in the page.
 *   - sandbox:          true   — renderer runs in an OS sandbox; preload is limited.
 *   - webSecurity:      true   — same-origin policy enforced.
 * The ONLY renderer→main bridge is the preload's `window.api` (contextBridge).
 */
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...WINDOW_DEFAULTS,
    show: false, // reveal only once the first paint is ready (avoids white flash)
    webPreferences: {
      // Preload is emitted by electron-vite as CommonJS `out/preload/index.cjs`
      // (a sandboxed preload must be CJS; see electron.vite.config.ts). This file
      // runs from `out/main/index.js`, so the sibling `../preload/` resolves it in
      // both dev and prod.
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  // Phase 5: on window focus, recompute merge-readiness checks for every workspace the
  // renderer has fetched (spec §5.5). A stable module-level listener reference is used so
  // it attaches once per window and the `before-quit` teardown can detach it cleanly.
  window.on('focus', refreshChecksOnFocus);

  if (isDev) {
    // Dev: load from the Vite dev server so HMR works. `rendererDevUrl` is defined
    // here because `isDev` is derived from it.
    void window.loadURL(rendererDevUrl as string);
  } else {
    // Prod: load the built renderer entry from disk (file: origin, locked by CSP).
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}

/**
 * Recompute merge-readiness checks for every workspace the renderer has fetched, on
 * window focus (spec §5.5). The tracked-id set is owned by `src/main/ipc/register.ts`
 * (populated by `checks:get`); each refresh is best-effort — a failure (no GitHub
 * account, a network error) is logged, never thrown. A no-op before the AppContext is
 * assembled. A stable reference so it can be detached in `before-quit`.
 */
function refreshChecksOnFocus(): void {
  const ctx = appContext;
  if (!ctx) return;
  for (const workspaceId of focusRefreshWorkspaceIds()) {
    void ctx.checks
      .refresh(workspaceId)
      .catch((err) =>
        logger.error(
          `[focus-refresh] checks refresh for ${workspaceId} failed: ${String(err)}`,
        ),
      );
  }
}

// --- Deep link (spec §5.8) -------------------------------------------------

/**
 * Handle an incoming `harness://…` deep link (spec §5.8). Resolve it to a nav target
 * and broadcast `nav:deepLink` to every open renderer (the nav store selects the
 * workspace/pane). Unroutable URLs are logged and ignored. Also focus a window so the
 * jump feels responsive even if the link arrived while the app was backgrounded.
 */
function handleDeepLink(url: string): void {
  logger.info(`[deep-link] received: ${url}`);
  const target = resolveDeepLink(url);
  if (target === null) {
    logger.warn(`[deep-link] unroutable, ignoring: ${url}`);
    return;
  }
  const windows = BrowserWindow.getAllWindows();
  emitAll(
    windows.map((w) => w.webContents),
    'nav:deepLink',
    target,
  );
  const [existing] = windows;
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  }
}

/** Pull the first `harness://` URL out of an argv array (Windows/Linux path). */
function findDeepLinkInArgv(argv: string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(`${DEEP_LINK_SCHEME}://`));
}

// --- Application menu / keyboard shortcuts (spec §5.4) ---------------------

/** Broadcast a menu/accelerator action to every open renderer (`menu:action`). */
function emitMenuAction(actionId: string): void {
  emitAll(
    BrowserWindow.getAllWindows().map((w) => w.webContents),
    'menu:action',
    { actionId },
  );
}

/**
 * Build the application menu from the resolved keymap (`shortcuts.ts`). Standard
 * roles (app/edit) keep native copy-paste etc.; the View/Workspace submenus expose our
 * accelerated actions, each of which broadcasts a `menu:action` the renderer handles.
 *
 * We deliberately use MENU accelerators, not `globalShortcut`: these bindings (⌘T, ⌘K,
 * ⌘1…) must fire only while the app is focused — a `globalShortcut` would hijack them
 * system-wide from every other app. So there is nothing to `unregisterAll()` on quit.
 */
function buildAppMenu(actions: readonly ShortcutAction[]): Menu {
  const byId = new Map(actions.map((a) => [a.id, a]));
  const item = (id: string): MenuItemConstructorOptions | null => {
    const a = byId.get(id);
    return a
      ? {
          label: a.label,
          accelerator: a.accelerator,
          click: () => emitMenuAction(a.id),
        }
      : null;
  };
  const workspaceItems = actions
    .filter((a) => a.id.startsWith('selectWorkspace:'))
    .map((a): MenuItemConstructorOptions => ({
      label: a.label,
      accelerator: a.accelerator,
      click: () => emitMenuAction(a.id),
    }));
  const nonNull = (
    items: (MenuItemConstructorOptions | null)[],
  ): MenuItemConstructorOptions[] =>
    items.filter((i): i is MenuItemConstructorOptions => i !== null);

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [{ role: 'appMenu' } as MenuItemConstructorOptions]
      : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: nonNull([
        item('showDiff'),
        item('showTerminal'),
        { type: 'separator' },
        item('commandPalette'),
        item('openSettings'),
        { type: 'separator' },
        ...NATIVE_VIEW_ROLES.map((role): MenuItemConstructorOptions => ({
          role,
        })),
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ]),
    },
    {
      label: 'Workspace',
      submenu: nonNull([
        item('newWorkspace'),
        item('openPr'),
        item('archiveWorkspace'),
        { type: 'separator' },
        ...workspaceItems,
      ]),
    },
  ];
  return Menu.buildFromTemplate(template);
}

// --- Lifecycle -------------------------------------------------------------

// Single-instance lock: a second launch (e.g. from a deep link) must forward to the
// running instance rather than spin up a duplicate. If we don't get the lock, quit.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  // Register as the default handler for `harness://` so the OS routes deep links here.
  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);

  // macOS delivers deep links via `open-url` (fires even before `whenReady`).
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  // Windows/Linux deliver deep links as argv to the second launch, surfaced here.
  app.on('second-instance', (_event, argv) => {
    const url = findDeepLinkInArgv(argv);
    if (url !== undefined) {
      handleDeepLink(url);
    }
    // Focus the existing window so the second launch feels like it "did something".
    const [existing] = BrowserWindow.getAllWindows();
    if (existing) {
      if (existing.isMinimized()) {
        existing.restore();
      }
      existing.focus();
    }
  });

  void app.whenReady().then(() => {
    // Order matters: CSP + IPC must be in place BEFORE the window loads content that
    // will call `app:ping` / DB IPC on mount.
    installCsp();

    const ctx = createAppContext();
    appContext = ctx;
    registerIpc(ctx);
    logger.info('[startup] IPC registered');

    createWindow();
    logger.info('[startup] window created');

    // Phase 6: install the application menu (accelerators broadcast `menu:action`).
    // Overrides would come from settings once a `[shortcuts]` section exists; today the
    // defaults are used. Menu accelerators need no quit teardown (see buildAppMenu).
    Menu.setApplicationMenu(buildAppMenu(resolveShortcuts()));
    logger.info('[startup] application menu installed');

    // Phase 6: best-effort update check on launch. No-op on the descoped (unsupported)
    // path; a failure is logged inside the service and never blocks startup.
    void ctx.updater.checkOnLaunch();

    // macOS: re-create a window when the dock icon is clicked with none open.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  // Standard macOS behavior: keep the app alive when all windows close (the user
  // re-opens via the dock); quit on other platforms.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // Quit-teardown (README §7.4). Interrupt every live agent turn FIRST (SIGINT each
  // child), THEN tree-kill the remaining process trees (run scripts + PTYs) via the
  // shared ProcessRegistry. `app.quit()` runs in `finally` so a hung teardown (an
  // unkillable tree — `treeKillEscalate` is hard-bounded) can never wedge shutdown.
  app.on('before-quit', (event) => {
    if (!appContext) return;
    event.preventDefault();
    const ctx = appContext;
    appContext = undefined; // guard against re-entry when we call app.quit() again
    // Phase 4: stop every diff FS watcher so chokidar handles don't outlive the app.
    try {
      ctx.diff.stopAll();
    } catch (err) {
      logger.error(`[shutdown] diff watcher teardown failed: ${String(err)}`);
    }
    // Phase 6: stop the settings hot-reload watcher (its own chokidar handle).
    try {
      ctx.settings.stopWatching();
    } catch (err) {
      logger.error(
        `[shutdown] settings watcher teardown failed: ${String(err)}`,
      );
    }
    // Phase 6: detach auto-updater listeners (no-op on the descoped path).
    try {
      ctx.updater.dispose();
    } catch (err) {
      logger.error(`[shutdown] updater teardown failed: ${String(err)}`);
    }
    // Phase 5: detach the per-window focus-refresh listener so it can't fire (or retain
    // the window) during/after teardown. Mirrors the diff-watcher teardown above.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.removeListener('focus', refreshChecksOnFocus);
      }
    }
    void ctx.harness
      .quitAll()
      .catch((err) => logger.error(`[shutdown] quitAll failed: ${String(err)}`))
      .then(() => ctx.process.registry.killAll())
      .catch((err) =>
        logger.error(`[shutdown] process teardown failed: ${String(err)}`),
      )
      .finally(() => {
        logger.info('[shutdown] agents interrupted + process trees torn down');
        app.quit();
      });
  });
}
