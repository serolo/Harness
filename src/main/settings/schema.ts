// Effective (merged) settings schema — spec §5.7, README §6.5.
//
// This is the READ-ONLY Phase 0 schema. Every section carries real, sensible
// `.default(...)` values so that parsing an empty object (`{}`) yields a fully
// populated `EffectiveSettings` — the layered merge (see `./index.ts`) relies on
// this to fill any gaps left by the TOML layers.
//
// The zod SCHEMA is exported (not just the inferred type) so Phase 6 can reuse it
// for the write path, validation surfacing, and hot-reload. If a *published* JSON
// Schema is later wanted (Settings UI provenance, external tooling), the
// `zod-to-json-schema` package can convert `EffectiveSettingsSchema` — it is not a
// dependency yet; add it in Phase 6 when the write path lands.
//
// The `agent` section mirrors the frozen `HarnessId` / `AgentMode` /
// `PermissionPolicy` / `McpServerConfig` types from `@shared/harness`. The zod
// shapes below are kept structurally identical to those types; the
// `satisfies`-style aliases at the bottom document the intended alignment. The
// frozen types remain the single source of truth for anything crossing the
// process boundary (README §5.2) — these zod mirrors exist only to parse/coerce
// on-disk TOML into that shape.

import { z } from 'zod';

import type {
  AgentMode,
  HarnessId,
  McpServerConfig,
  PermissionPolicy,
} from '@shared/harness';
import type { EffectiveSettings as SharedEffectiveSettings } from '@shared/settings';

// --- [agent] enum mirrors of the frozen @shared/harness unions ---------------

/** Mirrors `HarnessId` from `@shared/harness`. */
const harnessIdSchema = z.enum(['claude_code', 'codex', 'cursor']);

/** Mirrors `AgentMode` from `@shared/harness`. */
const agentModeSchema = z.enum(['plan', 'default', 'auto_accept']);

/** Mirrors `PermissionPolicy` from `@shared/harness` (all fields optional). */
const permissionPolicySchema = z.object({
  allowedTools: z.array(z.string()).optional(),
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  confirmBeforeRun: z.boolean().optional(),
});

/** Mirrors `McpServerConfig` from `@shared/harness`. */
const mcpServerConfigSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

// --- [scripts] ----------------------------------------------------------------

/**
 * A single named run script (spec §5.7 `[scripts]` `run`). Modeled as
 * name + command with optional presentation hints so the run overlay (Phase 3)
 * can render a button per script. Kept forward-compatible: unknown display
 * fields can be added without breaking older configs.
 */
const namedScriptSchema = z.object({
  /** Stable identifier used to key the process registry (Phase 3). */
  name: z.string(),
  /** Shell command to execute in the workspace directory. */
  command: z.string(),
  /** Optional human label for the UI (falls back to `name`). */
  label: z.string().optional(),
  /** Optional icon hint for the run overlay. */
  icon: z.string().optional(),
});

/**
 * `[scripts]` — lifecycle + run scripts (spec §5.7).
 * `setup`/`archive` are single shell commands; `run` is a list of named scripts.
 * `run_mode` decides whether multiple run scripts start together or one-at-a-time.
 */
const scriptsSchema = z
  .object({
    /** Command run once when a workspace is created (deps install, etc.). */
    setup: z.string().optional(),
    /** Named long-running processes (dev servers, watchers). Default: none. */
    run: z.array(namedScriptSchema).default([]),
    /** Command run when a workspace is archived (teardown). */
    archive: z.string().optional(),
    /** Whether `run` scripts start concurrently or one at a time. */
    run_mode: z.enum(['concurrent', 'single']).default('single'),
  })
  .default({});

// --- [git] --------------------------------------------------------------------

/** `[git]` — branch naming + merge strategy (spec §5.7). */
const gitSchema = z
  .object({
    /** Prefix for agent-created branches, e.g. `agent/<workspace-name>`. */
    branchPrefix: z.string().default('agent'),
    /** Strategy used by the Merge button (spec §5.6). */
    mergeStrategy: z.enum(['merge', 'squash', 'rebase']).default('squash'),
  })
  .default({});

// --- [agent] ------------------------------------------------------------------

/**
 * `[agent]` — default harness + run mode + permission policy (spec §5.7).
 * `prompts` is a free-form map of reusable prompt templates (PR title/body, etc.)
 * consumed by later phases; left permissive here since Phase 0 does not read it.
 */
const agentSchema = z
  .object({
    /** Harness used when a workspace does not pin one. */
    defaultHarness: harnessIdSchema.default('claude_code'),
    /** Default agent run mode for new turns. */
    mode: agentModeSchema.default('default'),
    /** Default permission policy; empty object = harness defaults apply. */
    permissionPolicy: permissionPolicySchema.default({}),
    /** Named prompt templates (e.g. `prTitle`, `prBody`). */
    prompts: z.record(z.string(), z.string()).default({}),
    /**
     * Prompt prefix for the one-click "Agent review" action (Phase 4, spec §5.3). The
     * review handler composes this with the current diff summary and feeds it into a
     * normal turn. Kept as a plain string so a project can override the review persona.
     */
    reviewPrompt: z
      .string()
      .default(
        'Please review the changes in the current diff. Focus on correctness bugs, ' +
          'security issues, and clear simplifications. Reference specific files and ' +
          'lines, and group your feedback by file.',
      ),
    /**
     * Prompt prefix for the one-click "Create PR" action (Phase 5, spec §5.6). The PR
     * handler composes this with the current diff summary to draft a PR title + body,
     * mirroring how `reviewPrompt` seeds the Agent-review turn. Kept as a plain string
     * so a project can override the PR-authoring persona.
     */
    prPrompt: z
      .string()
      .default(
        'Draft a concise pull request for the changes in the current diff. Return a ' +
          'short, imperative title (under 70 characters) on the first line, then a blank ' +
          'line, then a brief body summarizing what changed and why. Reference the key ' +
          'files touched; do not include unrelated commentary.',
      ),
    /**
     * Which harness IMPLEMENTATION backs the `claude_code` id (Phase 2, D2). `auto`
     * uses the real CLI adapter; `mock` uses the scripted `MockHarness`. Env overrides
     * (`AGENTAPP_MOCK_HARNESS=1`, `AGENTAPP_E2E=1`) force `mock` at construction time.
     */
    harnessImpl: z.enum(['auto', 'mock']).default('auto'),
  })
  .default({});

// --- [notifications] ----------------------------------------------------------

/**
 * `[notifications]` — native turn notifications (spec §5.8, Phase 2). All toggles
 * default on and the whole section defaults to `{}`, so an empty config still parses
 * into a fully-populated object (the layered-merge invariant).
 */
const notificationsSchema = z
  .object({
    /** Master switch — off silences all native notifications. */
    enabled: z.boolean().default(true),
    /** Notify when a turn completes cleanly. */
    onTurnComplete: z.boolean().default(true),
    /** Notify when a turn ends with an error. */
    onError: z.boolean().default(true),
    /** Umbrella toggle for attention-needing states (errors, permission prompts). */
    onNeedsAttention: z.boolean().default(true),
  })
  .default({});

// --- Top-level EffectiveSettings ---------------------------------------------

/**
 * The full merged settings object. Parsing `{}` through this schema yields every
 * section fully populated with defaults — the invariant the layered merge relies
 * on (`./index.ts`).
 */
export const EffectiveSettingsSchema = z
  .object({
    scripts: scriptsSchema,
    /** `[env]` — extra environment variables injected into scripts/agents. */
    env: z.record(z.string(), z.string()).default({}),
    agent: agentSchema,
    git: gitSchema,
    /** `[mcp]` — MCP servers passed through to the agent CLI. */
    mcp: z.array(mcpServerConfigSchema).default([]),
    /** `[notifications]` — native turn notifications (Phase 2). */
    notifications: notificationsSchema,
  })
  .default({});

/** The inferred, fully-defaulted settings type consumed via `settings.get()`. */
export type EffectiveSettings = z.infer<typeof EffectiveSettingsSchema>;

// --- Compile-time alignment guards -------------------------------------------
// These `never`-typed assignments fail to compile if the zod mirrors ever drift
// from the frozen `@shared/harness` types, catching contract skew at build time.

type _AssertHarnessId =
  HarnessId extends z.infer<typeof harnessIdSchema>
    ? z.infer<typeof harnessIdSchema> extends HarnessId
      ? true
      : never
    : never;
type _AssertAgentMode =
  AgentMode extends z.infer<typeof agentModeSchema>
    ? z.infer<typeof agentModeSchema> extends AgentMode
      ? true
      : never
    : never;
type _AssertPermissionPolicy =
  z.infer<typeof permissionPolicySchema> extends PermissionPolicy
    ? true
    : never;
type _AssertMcpServerConfig =
  z.infer<typeof mcpServerConfigSchema> extends McpServerConfig ? true : never;

// The whole effective object must stay structurally identical to the frozen
// `@shared/settings` DTO that crosses the IPC boundary — bidirectional so neither
// side can silently gain/lose a field. `settings:getEffective` returns this shape.
type _AssertEffectiveSettings =
  EffectiveSettings extends SharedEffectiveSettings
    ? SharedEffectiveSettings extends EffectiveSettings
      ? true
      : never
    : never;

// Reference the guards so `noUnusedLocals` does not flag them.
const _alignment: [
  _AssertHarnessId,
  _AssertAgentMode,
  _AssertPermissionPolicy,
  _AssertMcpServerConfig,
  _AssertEffectiveSettings,
] = [true, true, true, true, true];
void _alignment;
