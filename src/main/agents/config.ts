import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, opendir, readFile, realpath } from 'node:fs/promises';
import {
  basename,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';
import { parseDocument } from 'yaml';
import { AppError } from '@shared/errors';
import {
  META_AGENT_SCHEMA_VERSION,
  type AgentDispatchPurpose,
  type AgentRunPolicy,
  type AgentValidationDiagnostic,
  type MetaAgentCapability,
  type MetaAgentProtocol,
  type NormalizedAgentSnapshot,
} from '@shared/agents';
import type { HarnessId } from '@shared/harness';

export const MAX_AGENT_FILE_BYTES = 256 * 1024;
export const MAX_AGENT_BUNDLE_BYTES = 2 * 1024 * 1024;
export const MAX_AGENT_BUNDLE_ENTRIES = 128;
const MAX_NODES = 2_000;
const MAX_DEPTH = 20;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
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
const ROOT_KEYS = new Set([
  'version',
  'name',
  'description',
  'protocol',
  'prompt',
  'instructions',
  'executor',
  'tools',
  'policy',
  'requires',
]);
const EXECUTOR_KEYS = new Set([
  'harness',
  'model',
  'mode',
  'read_only',
  'config',
]);
const POLICY_KEYS = new Set([
  'max_dispatches',
  'max_parallel',
  'turn_timeout_ms',
  'run_timeout_ms',
  'max_request_bytes',
  'max_result_bytes',
  'critique_rounds',
]);

type Plain = Record<string, unknown>;

export interface BundleLoadResult {
  snapshot?: NormalizedAgentSnapshot;
  diagnostics: AgentValidationDiagnostic[];
  files: string[];
}

function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diagnostic(
  message: string,
  file: string,
  code = 'invalid_config',
): AgentValidationDiagnostic {
  return { severity: 'error', code, message, file };
}

function assertKnownKeys(
  value: Plain,
  allowed: Set<string>,
  file: string,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new AppError(
        'invalid_input',
        `${file}: unsupported ${label} field "${key}"`,
      );
    }
  }
}

function countNodes(value: unknown, depth = 0, count = { value: 0 }): void {
  if (depth > MAX_DEPTH)
    throw new AppError('invalid_input', 'agent YAML exceeds maximum depth');
  count.value += 1;
  if (count.value > MAX_NODES)
    throw new AppError('invalid_input', 'agent YAML is too complex');
  if (Array.isArray(value))
    for (const item of value) countNodes(item, depth + 1, count);
  else if (isPlain(value))
    for (const item of Object.values(value)) countNodes(item, depth + 1, count);
}

export function parseAgentYaml(content: string, file = 'config.yaml'): Plain {
  if (Buffer.byteLength(content, 'utf8') > MAX_AGENT_FILE_BYTES) {
    throw new AppError('invalid_input', `${file}: file is too large`);
  }
  const doc = parseDocument(content, {
    strict: true,
    uniqueKeys: true,
    prettyErrors: true,
    stringKeys: true,
  });
  if (doc.errors.length > 0) {
    throw new AppError(
      'invalid_input',
      `${file}: ${doc.errors[0]?.message ?? 'invalid YAML'}`,
    );
  }
  const value: unknown = doc.toJS({ maxAliasCount: 0 });
  if (!isPlain(value))
    throw new AppError('invalid_input', `${file}: root must be a mapping`);
  countNodes(value);
  assertKnownKeys(value, ROOT_KEYS, file, 'root');
  return value;
}

function requiredString(obj: Plain, key: string, file: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(
      'invalid_input',
      `${file}: ${key} must be a non-empty string`,
    );
  }
  return value.trim();
}

function optionalString(
  obj: Plain,
  key: string,
  file: string,
): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string')
    throw new AppError('invalid_input', `${file}: ${key} must be a string`);
  return value.trim();
}

function parseExecutor(
  value: unknown,
  file: string,
): {
  harness: HarnessId;
  model?: string;
  mode: 'plan' | 'default';
  readOnlyMode: boolean;
} {
  if (!isPlain(value))
    throw new AppError('invalid_input', `${file}: executor must be a mapping`);
  assertKnownKeys(value, EXECUTOR_KEYS, file, 'executor');
  const config = value.config;
  if (config !== undefined && !isPlain(config))
    throw new AppError(
      'invalid_input',
      `${file}: executor.config must be a mapping`,
    );
  if (isPlain(config))
    assertKnownKeys(config, new Set(['harness']), file, 'executor.config');
  const rawHarness =
    value.harness ?? (isPlain(config) ? config.harness : undefined);
  if (
    typeof rawHarness !== 'string' ||
    !HARNESSES.has(rawHarness as HarnessId)
  ) {
    throw new AppError(
      'invalid_input',
      `${file}: executor harness is unsupported`,
    );
  }
  if (
    value.harness !== undefined &&
    isPlain(config) &&
    config.harness !== undefined &&
    value.harness !== config.harness
  ) {
    throw new AppError(
      'invalid_input',
      `${file}: executor harness shapes conflict`,
    );
  }
  const mode = value.mode ?? 'default';
  if (mode !== 'default' && mode !== 'plan')
    throw new AppError(
      'invalid_input',
      `${file}: executor.mode must be default or plan`,
    );
  const model = optionalString(value, 'model', file);
  if (value.read_only !== undefined && typeof value.read_only !== 'boolean')
    throw new AppError(
      'invalid_input',
      `${file}: executor.read_only must be boolean`,
    );
  return {
    harness: rawHarness as HarnessId,
    ...(model ? { model } : {}),
    mode,
    // Existing plan configurations remain read-only, while providers without a
    // native plan mode can request the independent sandbox property explicitly.
    readOnlyMode: value.read_only === true || mode === 'plan',
  };
}

function integer(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  const candidate = value ?? fallback;
  if (
    !Number.isInteger(candidate) ||
    (candidate as number) < min ||
    (candidate as number) > max
  ) {
    throw new AppError(
      'invalid_input',
      `${label} must be an integer from ${min} to ${max}`,
    );
  }
  return candidate as number;
}

function parsePolicy(value: unknown): AgentRunPolicy {
  const obj = value === undefined ? {} : value;
  if (!isPlain(obj))
    throw new AppError('invalid_input', 'policy must be a mapping');
  assertKnownKeys(obj, POLICY_KEYS, 'config.yaml', 'policy');
  return {
    maxDispatches: integer(obj.max_dispatches, 8, 1, 32, 'max_dispatches'),
    maxParallel: integer(obj.max_parallel, 3, 1, 8, 'max_parallel'),
    maxDepth: 1,
    turnTimeoutMs: integer(
      obj.turn_timeout_ms,
      1_800_000,
      10_000,
      7_200_000,
      'turn_timeout_ms',
    ),
    runTimeoutMs: integer(
      obj.run_timeout_ms,
      7_200_000,
      60_000,
      28_800_000,
      'run_timeout_ms',
    ),
    maxRequestBytes: integer(
      obj.max_request_bytes,
      65_536,
      1_024,
      262_144,
      'max_request_bytes',
    ),
    maxResultBytes: integer(
      obj.max_result_bytes,
      131_072,
      1_024,
      524_288,
      'max_result_bytes',
    ),
    critiqueRounds: integer(obj.critique_rounds, 0, 0, 3, 'critique_rounds'),
  };
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new AppError('invalid_input', `${label} must be a string array`);
  }
  return [...new Set(value as string[])];
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  );
}

async function safeRead(root: string, relativePath: string): Promise<string> {
  const lexical = resolve(root, relativePath);
  if (!contained(resolve(root), lexical))
    throw new AppError('invalid_input', `path escapes bundle: ${relativePath}`);
  const stat = await lstat(lexical);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new AppError(
      'invalid_input',
      `bundle file is not a regular file: ${relativePath}`,
    );
  if (stat.size > MAX_AGENT_FILE_BYTES)
    throw new AppError(
      'invalid_input',
      `bundle file is too large: ${relativePath}`,
    );
  const [realRoot, realTarget] = await Promise.all([
    realpath(root),
    realpath(lexical),
  ]);
  if (!contained(realRoot, realTarget))
    throw new AppError('invalid_input', `path escapes bundle: ${relativePath}`);
  return readFile(realTarget, 'utf8');
}

export function isAllowedAgentFile(path: string): boolean {
  return (
    path === 'config.yaml' ||
    /^agents\/[a-z0-9](?:[a-z0-9-]{0,62})\/config\.yaml$/.test(path) ||
    /^(?:agents\/[a-z0-9](?:[a-z0-9-]{0,62})\/)?[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126})\.md$/.test(
      path,
    ) ||
    /^skills\/[a-z0-9](?:[a-z0-9-]{0,62})\/SKILL\.md$/.test(path)
  );
}

async function discoverFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  let inspectedEntries = 0;
  const readEntries = async (dir: string): Promise<Dirent[]> => {
    const entries: Dirent[] = [];
    const handle = await opendir(dir);
    for await (const entry of handle) {
      inspectedEntries += 1;
      if (inspectedEntries > MAX_AGENT_BUNDLE_ENTRIES)
        throw new AppError(
          'invalid_input',
          `agent bundle exceeds ${MAX_AGENT_BUNDLE_ENTRIES} entries`,
        );
      entries.push(entry);
    }
    return entries;
  };
  const rootEntries = await readEntries(root);
  for (const entry of rootEntries) {
    if (entry.name === 'config.yaml') {
      if (!entry.isFile())
        throw new AppError(
          'invalid_input',
          'bundle file is not a regular file: config.yaml',
        );
      out.push(entry.name);
      continue;
    }
    if (
      /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126})\.md$/.test(entry.name) &&
      entry.isFile()
    ) {
      out.push(entry.name);
      continue;
    }
    if (
      (entry.name === 'agents' || entry.name === 'skills') &&
      entry.isDirectory()
    ) {
      const area = entry.name;
      const children = await readEntries(join(root, area));
      for (const child of children) {
        if (!child.isDirectory() || !SLUG.test(child.name))
          throw new AppError(
            'invalid_input',
            `unexpected bundle entry: ${area}/${child.name}`,
          );
        const nested = await readEntries(join(root, area, child.name));
        for (const file of nested) {
          const relativePath = `${area}/${child.name}/${file.name}`;
          const allowed =
            file.isFile() &&
            (area === 'skills'
              ? file.name === 'SKILL.md'
              : file.name === 'config.yaml' ||
                /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126})\.md$/.test(file.name));
          if (!allowed)
            throw new AppError(
              'invalid_input',
              `unexpected files below ${area}/${child.name}: ${relativePath}`,
            );
          out.push(relativePath);
        }
      }
      continue;
    }
    throw new AppError(
      'invalid_input',
      `unexpected bundle entry: ${entry.name}`,
    );
  }
  if (!out.includes('config.yaml'))
    throw new AppError('invalid_input', 'missing config.yaml');
  return out.sort();
}

function resolvedInstructions(
  value: Plain,
  configFile: string,
  contents: ReadonlyMap<string, string>,
): { content?: string; file?: string } {
  const reference = optionalString(value, 'instructions', configFile);
  if (reference === undefined) return {};
  if (
    reference === '' ||
    reference.includes('\\') ||
    posix.isAbsolute(reference)
  )
    throw new AppError(
      'invalid_input',
      `${configFile}: instructions must be a relative Markdown file`,
    );
  const configDir = posix.dirname(configFile);
  const file = posix.normalize(posix.join(configDir, reference));
  const expectedPrefix =
    configDir === '.' ? '' : `${configDir.replace(/\/$/, '')}/`;
  if (
    !file.startsWith(expectedPrefix) ||
    !isAllowedAgentFile(file) ||
    !file.toLowerCase().endsWith('.md')
  )
    throw new AppError(
      'invalid_input',
      `${configFile}: instructions path escapes its agent directory`,
    );
  const content = contents.get(file);
  if (content === undefined)
    throw new AppError(
      'invalid_input',
      `${configFile}: missing instructions file: ${file}`,
    );
  return { content, file };
}

export async function loadAgentBundle(
  bundleDir: string,
  slugOverride?: string,
): Promise<BundleLoadResult> {
  try {
    const files = await discoverFiles(bundleDir);
    const contents = new Map<string, string>();
    let total = 0;
    for (const file of files) {
      const content = await safeRead(bundleDir, file);
      total += Buffer.byteLength(content, 'utf8');
      if (total > MAX_AGENT_BUNDLE_BYTES)
        throw new AppError('invalid_input', 'agent bundle is too large');
      contents.set(file, content);
    }
    const root = parseAgentYaml(
      contents.get('config.yaml') ?? '',
      'config.yaml',
    );
    const version = root.version ?? META_AGENT_SCHEMA_VERSION;
    if (version !== META_AGENT_SCHEMA_VERSION)
      throw new AppError(
        'invalid_input',
        `unsupported agent schema version: ${String(version)}`,
      );
    const slug =
      slugOverride ??
      basename(bundleDir).split('.staging-')[0] ??
      basename(bundleDir);
    if (!SLUG.test(slug))
      throw new AppError('invalid_input', `invalid agent slug: ${slug}`);
    const tools = root.tools ?? {};
    if (!isPlain(tools))
      throw new AppError('invalid_input', 'tools must be a mapping');
    assertKnownKeys(
      tools,
      new Set(['agents', 'skills']),
      'config.yaml',
      'tools',
    );
    const roleSlugs = stringList(tools.agents, 'tools.agents');
    const skillSlugs = stringList(tools.skills, 'tools.skills');
    const referencedFiles = new Set<string>(['config.yaml']);
    const rootInstructions = resolvedInstructions(
      root,
      'config.yaml',
      contents,
    );
    if (rootInstructions.file) referencedFiles.add(rootInstructions.file);
    const roles = roleSlugs.map((roleSlug) => {
      if (!SLUG.test(roleSlug))
        throw new AppError(
          'invalid_input',
          `invalid child agent slug: ${roleSlug}`,
        );
      const file = `agents/${roleSlug}/config.yaml`;
      const raw = contents.get(file);
      if (raw === undefined)
        throw new AppError(
          'invalid_input',
          `missing referenced child config: ${file}`,
        );
      const child = parseAgentYaml(raw, file);
      referencedFiles.add(file);
      const instructions = resolvedInstructions(child, file, contents);
      if (instructions.file) referencedFiles.add(instructions.file);
      const childTools = child.tools ?? {};
      if (!isPlain(childTools)) {
        throw new AppError('invalid_input', `${file}: tools must be a mapping`);
      }
      assertKnownKeys(
        childTools,
        new Set(['purposes', 'independent_provider']),
        file,
        'tools',
      );
      if (
        childTools.independent_provider !== undefined &&
        typeof childTools.independent_provider !== 'boolean'
      ) {
        throw new AppError(
          'invalid_input',
          `${file}: independent_provider must be boolean`,
        );
      }
      const purposes = stringList(
        childTools.purposes,
        `${file}: tools.purposes`,
      );
      const normalizedPurposes = purposes.length ? purposes : ['implement'];
      if (
        normalizedPurposes.some(
          (purpose) => !PURPOSES.has(purpose as AgentDispatchPurpose),
        )
      )
        throw new AppError(
          'invalid_input',
          `${file}: unsupported dispatch purpose`,
        );
      return {
        slug: roleSlug,
        name: optionalString(child, 'name', file) ?? roleSlug,
        description: optionalString(child, 'description', file),
        prompt: requiredString(child, 'prompt', file),
        instructions: instructions.content,
        executor: parseExecutor(child.executor, file),
        purposes: normalizedPurposes as AgentDispatchPurpose[],
        independentProvider: childTools.independent_provider === true,
      };
    });
    const skills = skillSlugs.map((skillSlug) => {
      if (!SLUG.test(skillSlug))
        throw new AppError('invalid_input', `invalid skill slug: ${skillSlug}`);
      const file = `skills/${skillSlug}/SKILL.md`;
      const content = contents.get(file);
      if (content === undefined)
        throw new AppError(
          'invalid_input',
          `missing referenced skill: ${file}`,
        );
      referencedFiles.add(file);
      return { slug: skillSlug, content };
    });
    const unexpected = files.find((file) => !referencedFiles.has(file));
    if (unexpected)
      throw new AppError(
        'invalid_input',
        `unexpected or unreferenced bundle file: ${unexpected}`,
      );
    const requires = root.requires ?? {};
    if (!isPlain(requires))
      throw new AppError('invalid_input', 'requires must be a mapping');
    assertKnownKeys(
      requires,
      new Set(['providers']),
      'config.yaml',
      'requires',
    );
    const configuredProviders = stringList(
      requires.providers,
      'requires.providers',
    );
    if (
      configuredProviders.some(
        (provider) => !HARNESSES.has(provider as HarnessId),
      )
    )
      throw new AppError(
        'invalid_input',
        'requires.providers contains an unsupported provider',
      );
    const coordinator = parseExecutor(root.executor, 'config.yaml');
    if (!coordinator.readOnlyMode)
      throw new AppError(
        'invalid_input',
        'config.yaml: coordinator executor must set read_only: true or use plan mode',
      );
    const requiredProviders = [
      ...new Set([
        ...configuredProviders,
        coordinator.harness,
        ...roles.map((role) => role.executor.harness),
      ]),
    ] as HarnessId[];
    const policy = parsePolicy(root.policy);
    const rawProtocol = root.protocol;
    if (rawProtocol !== undefined && rawProtocol !== 'debby')
      throw new AppError(
        'invalid_input',
        'config.yaml: protocol must be a supported closed protocol',
      );
    const protocol = rawProtocol as MetaAgentProtocol | undefined;
    const capabilities: MetaAgentCapability[] = [
      'delegate',
      'continue_dispatch',
      'await_dispatches',
      'cancel_dispatch',
    ];
    const base = {
      schemaVersion: META_AGENT_SCHEMA_VERSION,
      slug,
      name: requiredString(root, 'name', 'config.yaml'),
      description: optionalString(root, 'description', 'config.yaml') ?? '',
      prompt: requiredString(root, 'prompt', 'config.yaml'),
      instructions: rootInstructions.content,
      coordinator,
      roles,
      skills,
      capabilities,
      requiredProviders,
      policy,
      ...(protocol ? { protocol } : {}),
    };
    const revision = createHash('sha256')
      .update(JSON.stringify(base))
      .digest('hex');
    return { snapshot: { ...base, revision }, diagnostics: [], files };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'invalid agent bundle';
    const file =
      message.match(
        /^((?:agents\/[a-z0-9-]+\/)?(?:config\.yaml|[A-Za-z0-9._-]+\.md)|skills\/[a-z0-9-]+\/SKILL\.md):/,
      )?.[1] ?? 'config.yaml';
    const location = message.match(/at line (\d+), column (\d+)/i);
    return {
      diagnostics: [
        {
          ...diagnostic(message.replace(`${file}: `, ''), file),
          ...(location
            ? { line: Number(location[1]), column: Number(location[2]) }
            : {}),
        },
      ],
      files: [],
    };
  }
}

export async function readBundleFile(
  bundleDir: string,
  path: string,
): Promise<string> {
  if (!isAllowedAgentFile(path))
    throw new AppError('invalid_input', 'unsupported agent bundle path');
  return safeRead(bundleDir, path);
}
