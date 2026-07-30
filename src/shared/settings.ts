// FROZEN CONTRACT (src/shared/** is append-only — README §5.2).
//
// The cross-boundary shape of the effective (merged) settings + the Phase-6
// provenance / validation DTOs. These live in `@shared` because they cross the
// IPC boundary (`settings:getEffective` / `settings:getProvenance` / `settings:set`
// in `@shared/ipc`), and `src/shared/**` must be import-safe from BOTH processes.
//
// The zod schema in `src/main/settings/schema.ts` is the runtime validator that
// coerces on-disk TOML into this shape; it carries compile-time `_Assert*` guards
// that fail the build if `z.infer<EffectiveSettingsSchema>` ever drifts from the
// interfaces here. As with the `@shared/harness` mirrors already in that file,
// these shared types remain the single source of truth for the boundary.

import type {
  AgentMode,
  HarnessId,
  McpServerConfig,
  PermissionPolicy,
} from './harness';

/** A single named run script (spec §5.7 `[scripts]` `run`). */
export interface NamedScript {
  /** Stable identifier used to key the process registry (Phase 3). */
  name: string;
  /** Shell command to execute in the workspace directory. */
  command: string;
  /** Optional human label for the UI (falls back to `name`). */
  label?: string;
  /** Optional icon hint for the run overlay. */
  icon?: string;
}

/** `[scripts]` — lifecycle + run scripts (spec §5.7). */
export interface ScriptsSettings {
  /** Command run once when a workspace is created (deps install, etc.). */
  setup?: string;
  /** Named long-running processes (dev servers, watchers). */
  run: NamedScript[];
  /** Command run when a workspace is archived (teardown). */
  archive?: string;
  /** Whether `run` scripts start concurrently or one at a time. */
  run_mode: 'concurrent' | 'single';
}

/** `[git]` — branch naming + merge strategy (spec §5.7). */
export interface GitSettings {
  /** Prefix for agent-created branches, e.g. `agent/<workspace-name>`. */
  branchPrefix: string;
  /** Strategy used by the Merge button (spec §5.6). */
  mergeStrategy: 'merge' | 'squash' | 'rebase';
  /** Remove managed worktrees from disk when their workspace is archived. */
  deleteWorktreeOnArchive: boolean;
}

/** `[agent]` — default harness + run mode + permission policy (spec §5.7). */
export interface AgentSettings {
  /** Harness used when a workspace does not pin one. */
  defaultHarness: HarnessId;
  /** Default agent run mode for new turns. */
  mode: AgentMode;
  /** Default permission policy; empty object = harness defaults apply. */
  permissionPolicy: PermissionPolicy;
  /** Named prompt templates (e.g. `prTitle`, `prBody`); also feeds slash commands. */
  prompts: Record<string, string>;
  /** Prompt prefix for the one-click "Agent review" action (Phase 4). */
  reviewPrompt: string;
  /** Prompt prefix for the one-click "Create PR" action (Phase 5). */
  prPrompt: string;
  /** Which harness IMPLEMENTATION backs the `claude_code` id (`auto` CLI vs `mock`). */
  harnessImpl: 'auto' | 'mock';
}

/** `[notifications]` — native turn notifications (spec §5.8, Phase 2). */
export interface NotificationSettings {
  /** Master switch — off silences all native notifications. */
  enabled: boolean;
  /** Notify when a turn completes cleanly. */
  onTurnComplete: boolean;
  /** Notify when a turn ends with an error. */
  onError: boolean;
  /** Umbrella toggle for attention-needing states (errors, permission prompts). */
  onNeedsAttention: boolean;
  /** Sound played when any chat turn completes cleanly; `none` disables it. */
  completionSound: CompletionSound;
}

/** `[appearance]` — app-wide visual preferences. */
export interface AppearanceSettings {
  /** Color theme applied to the renderer root. */
  theme: AppearanceTheme;
}

/** Optional project knowledge wiki. Disabled by default. */
export interface KnowledgeSettings {
  enabled: boolean;
  storage: 'local' | 'github';
  proposal_mode: 'review_required';
  inject_context: boolean;
  extract_after_turn: boolean;
  show_notifications: boolean;
  search: {
    enabled: boolean;
    provider: 'qmd' | 'basic' | 'none';
    max_results: number;
    max_context_tokens: number;
    index_sources: boolean;
    rerank: boolean;
  };
}

/**
 * The full merged settings object. The layered merge (`src/main/settings`) fills
 * every section from defaults, so a consumer always receives a fully-populated
 * object regardless of what the TOML layers set.
 */
export interface EffectiveSettings {
  scripts: ScriptsSettings;
  /** `[env]` — extra environment variables injected into scripts/agents. */
  env: Record<string, string>;
  agent: AgentSettings;
  git: GitSettings;
  /** `[mcp]` — MCP servers passed through to the agent CLI. */
  mcp: McpServerConfig[];
  notifications: NotificationSettings;
  appearance: AppearanceSettings;
  /** `[knowledge]` — project wiki, opt-in and local-first. */
  knowledge: KnowledgeSettings;
}

/**
 * The four settings layers, in precedence order (low → high). `default` is the
 * schema's built-in defaults; project-shared is stored in SQLite, while user and
 * project-local remain TOML layers. Used as
 * the provenance tag (which layer supplied a leaf) and as the write target for
 * `settings:set` (`default` is NOT writable).
 */
export type SettingLayer =
  'default' | 'user' | 'project-shared' | 'project-local';

/** Layers that can be written to (everything except the built-in defaults). */
export type WritableSettingLayer = Exclude<SettingLayer, 'default'>;

/**
 * Per-leaf provenance: maps a dotted key path in the effective settings (e.g.
 * `git.branchPrefix`, `agent.permissionPolicy.confirmBeforeRun`) to the layer that
 * supplied its effective value. Arrays are ATOMIC — an array leaf (e.g. `mcp`,
 * `scripts.run`) maps its whole-array source layer, never a per-element path.
 */
export type SettingsProvenance = Record<string, SettingLayer>;

/**
 * A structured validation problem surfaced (instead of thrown) by the non-throwing
 * load path (`loadResult`) and the hot-reload watcher, so the Settings UI can point
 * at the offending file + key rather than crashing on bad TOML/zod input.
 */
export interface SettingsIssue {
  /** Absolute path to the layer file the problem came from. */
  file: string;
  /** Dotted key path within that file, when the problem is attributable to one. */
  keyPath?: string;
  /** Human-readable description (TOML parse error or zod message). */
  message: string;
}

/** Project-scoped settings payload used by the Repo settings screen. */
export interface ProjectSettingsSnapshot {
  settings: EffectiveSettings;
  provenance: SettingsProvenance;
  issues: SettingsIssue[];
}

// --- Completion-sound settings (APPEND-ONLY) -------------------------------

/** macOS system tones available for a clean chat-turn completion. */
export const COMPLETION_SOUNDS = [
  'none',
  'glass',
  'hero',
  'ping',
  'pop',
  'submarine',
] as const;

export type CompletionSound = (typeof COMPLETION_SOUNDS)[number];

/** Runtime guard for untrusted IPC/settings values. */
export function isCompletionSound(value: unknown): value is CompletionSound {
  return (
    typeof value === 'string' &&
    (COMPLETION_SOUNDS as readonly string[]).includes(value)
  );
}

// --- Appearance settings (APPEND-ONLY) --------------------------------------

export const APPEARANCE_THEMES = ['dark', 'light'] as const;

export type AppearanceTheme = (typeof APPEARANCE_THEMES)[number];

/** Runtime guard for untrusted IPC/settings values. */
export function isAppearanceTheme(value: unknown): value is AppearanceTheme {
  return (
    typeof value === 'string' &&
    (APPEARANCE_THEMES as readonly string[]).includes(value)
  );
}
