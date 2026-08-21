import { AppError } from '@shared/errors';
import {
  META_AGENT_SCHEMA_VERSION,
  type AgentDispatchPurpose,
  type AgentExecutorSnapshot,
  type AgentRoleSnapshot,
  type AgentRunPolicy,
  type MetaAgentCapability,
  type NormalizedAgentSnapshot,
} from '@shared/agents';
import type { HarnessId } from '@shared/harness';

type RecordValue = Record<string, unknown>;

const HARNESSES = new Set<HarnessId>(['claude_code', 'codex', 'cursor']);
const PURPOSES = new Set<AgentDispatchPurpose>([
  'research',
  'plan',
  'implement',
  'test',
  'review',
  'verify',
  'critique',
]);
const CAPABILITIES = new Set<MetaAgentCapability>([
  'delegate',
  'continue_dispatch',
  'await_dispatches',
  'cancel_dispatch',
  'push_with_consent',
  'open_pr_with_consent',
]);
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;

function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as RecordValue;
}

function exactKeys(
  value: RecordValue,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  )
    fail();
}

function string(value: unknown, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, 'utf8') > 262_144
  )
    fail();
  return value;
}

function executor(value: unknown): AgentExecutorSnapshot {
  const item = record(value);
  exactKeys(item, ['harness', 'mode'], ['model', 'readOnlyMode']);
  if (!HARNESSES.has(item.harness as HarnessId)) fail();
  if (item.mode !== 'plan' && item.mode !== 'default') fail();
  if (item.readOnlyMode !== undefined && typeof item.readOnlyMode !== 'boolean')
    fail();
  const model = item.model === undefined ? undefined : string(item.model);
  return {
    harness: item.harness as HarnessId,
    mode: item.mode,
    ...(item.readOnlyMode !== undefined
      ? { readOnlyMode: item.readOnlyMode }
      : {}),
    ...(model ? { model } : {}),
  };
}

function role(value: unknown): AgentRoleSnapshot {
  const item = record(value);
  exactKeys(
    item,
    ['slug', 'name', 'prompt', 'executor', 'purposes'],
    ['description', 'instructions', 'independentProvider'],
  );
  const slug = string(item.slug);
  if (!SLUG.test(slug)) fail();
  if (!Array.isArray(item.purposes) || item.purposes.length === 0) fail();
  const purposes = item.purposes.map((purpose) => {
    if (!PURPOSES.has(purpose as AgentDispatchPurpose)) fail();
    return purpose as AgentDispatchPurpose;
  });
  if (new Set(purposes).size !== purposes.length) fail();
  if (
    item.independentProvider !== undefined &&
    typeof item.independentProvider !== 'boolean'
  )
    fail();
  return {
    slug,
    name: string(item.name),
    prompt: string(item.prompt),
    executor: executor(item.executor),
    purposes,
    ...(item.description !== undefined
      ? { description: string(item.description, true) }
      : {}),
    ...(item.instructions !== undefined
      ? { instructions: string(item.instructions, true) }
      : {}),
    ...(item.independentProvider !== undefined
      ? { independentProvider: item.independentProvider }
      : {}),
  };
}

function policy(value: unknown): AgentRunPolicy {
  const item = record(value);
  exactKeys(item, [
    'maxDispatches',
    'maxParallel',
    'maxDepth',
    'turnTimeoutMs',
    'runTimeoutMs',
    'maxRequestBytes',
    'maxResultBytes',
    'critiqueRounds',
  ]);
  const bounded = (
    key: keyof AgentRunPolicy,
    min: number,
    max: number,
  ): number => {
    const candidate = item[key];
    if (
      typeof candidate !== 'number' ||
      !Number.isInteger(candidate) ||
      candidate < min ||
      candidate > max
    )
      fail();
    return candidate;
  };
  const result: AgentRunPolicy = {
    maxDispatches: bounded('maxDispatches', 1, 32),
    maxParallel: bounded('maxParallel', 1, 8),
    maxDepth: bounded('maxDepth', 1, 1) as 1,
    turnTimeoutMs: bounded('turnTimeoutMs', 10_000, 7_200_000),
    runTimeoutMs: bounded('runTimeoutMs', 60_000, 28_800_000),
    maxRequestBytes: bounded('maxRequestBytes', 1_024, 262_144),
    maxResultBytes: bounded('maxResultBytes', 1_024, 524_288),
    critiqueRounds: bounded('critiqueRounds', 0, 3),
  };
  if (result.maxParallel > result.maxDispatches) fail();
  return result;
}

/** Parse the persisted immutable snapshot using a closed, recursively typed schema. */
export function parseStoredAgentSnapshot(
  json: string,
): NormalizedAgentSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    fail();
  }
  const item = record(parsed);
  exactKeys(
    item,
    [
      'schemaVersion',
      'slug',
      'name',
      'description',
      'revision',
      'prompt',
      'coordinator',
      'roles',
      'skills',
      'capabilities',
      'requiredProviders',
      'policy',
    ],
    ['instructions', 'protocol'],
  );
  if (item.schemaVersion !== META_AGENT_SCHEMA_VERSION) fail();
  const slug = string(item.slug);
  if (!SLUG.test(slug)) fail();
  string(item.revision);
  if (!Array.isArray(item.roles) || !Array.isArray(item.skills)) fail();
  const roles = item.roles.map(role);
  if (new Set(roles.map((entry) => entry.slug)).size !== roles.length) fail();
  const skills = item.skills.map((value) => {
    const skill = record(value);
    exactKeys(skill, ['slug', 'content'], ['digest']);
    const skillSlug = string(skill.slug);
    if (!SLUG.test(skillSlug)) fail();
    const content = string(skill.content, true);
    const digest =
      skill.digest === undefined ? undefined : string(skill.digest);
    if (digest !== undefined && !/^[a-f0-9]{64}$/.test(digest)) fail();
    return {
      slug: skillSlug,
      content,
      ...(digest ? { digest } : {}),
    };
  });
  if (!Array.isArray(item.capabilities)) fail();
  const capabilities = item.capabilities.map((value) => {
    if (!CAPABILITIES.has(value as MetaAgentCapability)) fail();
    return value as MetaAgentCapability;
  });
  if (new Set(capabilities).size !== capabilities.length) fail();
  if (!Array.isArray(item.requiredProviders)) fail();
  const requiredProviders = item.requiredProviders.map((value) => {
    if (!HARNESSES.has(value as HarnessId)) fail();
    return value as HarnessId;
  });
  if (new Set(requiredProviders).size !== requiredProviders.length) fail();
  const coordinator = executor(item.coordinator);
  if (!(coordinator.readOnlyMode || coordinator.mode === 'plan')) fail();
  if (item.protocol !== undefined && item.protocol !== 'debby') fail();
  // Compatibility for snapshots written before protocol identity became explicit.
  const protocol = item.protocol ?? (slug === 'debby' ? 'debby' : undefined);
  return {
    schemaVersion: META_AGENT_SCHEMA_VERSION,
    slug,
    name: string(item.name),
    description: string(item.description, true),
    revision: item.revision as string,
    prompt: string(item.prompt),
    coordinator,
    roles,
    skills,
    capabilities,
    requiredProviders,
    policy: policy(item.policy),
    ...(protocol ? { protocol } : {}),
    ...(item.instructions !== undefined
      ? { instructions: string(item.instructions, true) }
      : {}),
  };
}

function fail(): never {
  throw new AppError('internal', 'stored agent snapshot schema is invalid');
}
