import { randomUUID } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { stringify as stringifyYaml } from 'yaml';
import { AppError } from '@shared/errors';
import type {
  AgentValidationDiagnostic,
  MetaAgentDetail,
  MetaAgentOrigin,
  MetaAgentSummary,
  NormalizedAgentSnapshot,
} from '@shared/agents';
import type { HarnessId } from '@shared/harness';
import { builtinAgentsDir, projectAgentsDir } from '../paths';
import {
  isAllowedAgentFile,
  loadAgentBundle,
  MAX_AGENT_FILE_BYTES,
  parseAgentYaml,
  readBundleFile,
} from './config';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;

interface RegistryEntry {
  id: string;
  projectId: string | null;
  origin: MetaAgentOrigin;
  dir: string;
  snapshot?: NormalizedAgentSnapshot;
  diagnostics: AgentValidationDiagnostic[];
  files: string[];
}

export interface AgentRegistryDeps {
  builtinsRoot?: string;
  projectRoot?: (projectId: string) => string;
  detectProviders: () => Promise<
    { id: HarnessId; installed: boolean; authenticated: boolean }[]
  >;
  emitChanged?: (
    projectId: string,
    agentId: string | undefined,
    reason: 'created' | 'changed' | 'deleted' | 'validation',
  ) => void;
  trashItem: (path: string) => Promise<void>;
  isAgentReferenced?: (projectId: string, agentId: string) => Promise<boolean>;
}

function stableId(
  origin: MetaAgentOrigin,
  projectId: string | null,
  slug: string,
): string {
  return origin === 'builtin'
    ? `builtin:${slug}`
    : `project:${projectId}:${slug}`;
}

function slugFromId(id: string): string {
  const slug = id.split(':').at(-1) ?? '';
  if (!SLUG.test(slug)) throw new AppError('invalid_input', 'invalid agent id');
  return slug;
}

export class AgentRegistry {
  private readonly deps: AgentRegistryDeps;
  private readonly cache = new Map<string, RegistryEntry>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly debounce = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: AgentRegistryDeps) {
    this.deps = deps;
  }

  async list(projectId: string): Promise<MetaAgentSummary[]> {
    await this.ensureLoaded(projectId);
    const providers = await this.deps.detectProviders();
    return [...this.cache.values()]
      .filter(
        (entry) => entry.origin === 'builtin' || entry.projectId === projectId,
      )
      .map((entry) => this.summary(entry, providers))
      .sort(
        (a, b) =>
          Number(b.origin === 'builtin') - Number(a.origin === 'builtin') ||
          a.name.localeCompare(b.name),
      );
  }

  async get(projectId: string, agentId: string): Promise<MetaAgentDetail> {
    await this.ensureLoaded(projectId);
    const entry = this.requireEntry(projectId, agentId);
    const providers = await this.deps.detectProviders();
    return {
      ...this.summary(entry, providers),
      files: entry.files,
    };
  }

  async resolveSnapshot(
    projectId: string,
    agentId: string,
  ): Promise<NormalizedAgentSnapshot> {
    await this.ensureLoaded(projectId);
    const entry = this.requireEntry(projectId, agentId);
    if (!entry.snapshot)
      throw new AppError('invalid_input', 'agent configuration is invalid', {
        agentId,
      });
    const providers = await this.deps.detectProviders();
    const summary = this.summary(entry, providers);
    if (!summary.available)
      throw new AppError('harness', summary.unavailableReasons.join('; '), {
        agentId,
      });
    return entry.snapshot;
  }

  async create(
    projectId: string,
    slug: string,
    name: string,
  ): Promise<MetaAgentDetail> {
    this.assertSlug(slug);
    if (name.trim() === '')
      throw new AppError('invalid_input', 'agent name is required');
    const target = join(this.projectRoot(projectId), slug);
    await this.assertAbsent(target);
    const staging = `${target}.staging-${randomUUID()}`;
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      await writeFile(
        join(staging, 'config.yaml'),
        `version: 1\nname: ${stringifyYaml(name.trim()).trim()}\ndescription: ''\nprompt: Describe the coordinator goal.\nexecutor:\n  harness: claude_code\n  mode: default\n  read_only: true\ntools:\n  agents: []\n  skills: []\npolicy:\n  max_dispatches: 4\n  max_parallel: 2\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
      await this.validateAndPublish(staging, target);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    await this.reloadEntry(projectId, 'project', slug, target, true);
    this.deps.emitChanged?.(
      projectId,
      stableId('project', projectId, slug),
      'created',
    );
    return this.get(projectId, stableId('project', projectId, slug));
  }

  async duplicate(
    projectId: string,
    sourceAgentId: string,
    slug: string,
  ): Promise<MetaAgentDetail> {
    this.assertSlug(slug);
    await this.ensureLoaded(projectId);
    const source = this.requireEntry(projectId, sourceAgentId);
    const target = join(this.projectRoot(projectId), slug);
    await this.assertAbsent(target);
    const staging = `${target}.staging-${randomUUID()}`;
    await cp(source.dir, staging, {
      recursive: true,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    try {
      await this.rejectSymlinks(staging);
      await this.validateAndPublish(staging, target);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    await this.reloadEntry(projectId, 'project', slug, target, true);
    this.deps.emitChanged?.(
      projectId,
      stableId('project', projectId, slug),
      'created',
    );
    return this.get(projectId, stableId('project', projectId, slug));
  }

  async importBundle(
    projectId: string,
    sourceDir: string,
  ): Promise<MetaAgentDetail> {
    const source = await lstat(sourceDir);
    if (!source.isDirectory() || source.isSymbolicLink())
      throw new AppError('invalid_input', 'import source must be a directory');
    const originalSlug = basename(sourceDir) || 'imported-agent';
    const base = SLUG.test(originalSlug) ? originalSlug : 'imported-agent';
    let slug = base;
    let suffix = 2;
    while (await this.exists(join(this.projectRoot(projectId), slug)))
      slug = `${base.slice(0, 58)}-${suffix++}`;
    const validated = await loadAgentBundle(sourceDir, slug);
    if (!validated.snapshot)
      throw new AppError(
        'invalid_input',
        validated.diagnostics[0]?.message ?? 'invalid agent bundle',
      );
    const target = join(this.projectRoot(projectId), slug);
    const staging = `${target}.staging-${randomUUID()}`;
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      // Copy only the bounded, validated manifest. Unknown trees are rejected by
      // loadAgentBundle before any potentially expensive recursive copy begins.
      for (const file of validated.files) {
        const content = await readBundleFile(sourceDir, file);
        const destination = join(staging, file);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, content, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
      }
      await this.validateAndPublish(staging, target);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    await this.reloadEntry(projectId, 'project', slug, target, true);
    this.deps.emitChanged?.(
      projectId,
      stableId('project', projectId, slug),
      'created',
    );
    return this.get(projectId, stableId('project', projectId, slug));
  }

  async readFile(
    projectId: string,
    agentId: string,
    path: string,
  ): Promise<{
    path: string;
    content: string;
    diagnostics: AgentValidationDiagnostic[];
  }> {
    await this.ensureLoaded(projectId);
    const entry = this.requireEntry(projectId, agentId);
    return {
      path,
      content: await readBundleFile(entry.dir, path),
      diagnostics: entry.diagnostics.filter((item) => item.file === path),
    };
  }

  async validateFile(
    path: string,
    content: string,
  ): Promise<AgentValidationDiagnostic[]> {
    if (!isAllowedAgentFile(path))
      throw new AppError('invalid_input', 'unsupported agent bundle path');
    if (Buffer.byteLength(content, 'utf8') > MAX_AGENT_FILE_BYTES)
      throw new AppError('invalid_input', 'agent bundle file is too large');
    if (path.endsWith('config.yaml')) parseAgentYaml(content, path);
    return [];
  }

  async saveFile(
    projectId: string,
    agentId: string,
    path: string,
    content: string,
  ): Promise<MetaAgentDetail> {
    return this.saveBundleFiles(projectId, agentId, [{ path, content }]);
  }

  async saveBundleFiles(
    projectId: string,
    agentId: string,
    files: { path: string; content: string | null }[],
  ): Promise<MetaAgentDetail> {
    await this.ensureLoaded(projectId);
    const entry = this.requireEntry(projectId, agentId);
    if (entry.origin !== 'project')
      throw new AppError('conflict', 'built-in agents are immutable');
    if (files.length === 0 || files.length > 128)
      throw new AppError('invalid_input', 'bundle edit count is invalid');
    if (new Set(files.map((file) => file.path)).size !== files.length)
      throw new AppError('invalid_input', 'bundle edit paths must be unique');
    for (const file of files) {
      if (!isAllowedAgentFile(file.path))
        throw new AppError('invalid_input', 'unsupported agent bundle path');
      if (file.path === 'config.yaml' && file.content === null)
        throw new AppError('invalid_input', 'config.yaml cannot be deleted');
      if (file.content !== null)
        await this.validateFile(file.path, file.content);
    }
    const staging = `${entry.dir}.staging-${randomUUID()}`;
    await cp(entry.dir, staging, {
      recursive: true,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    try {
      await this.rejectSymlinks(staging);
      for (const file of files) {
        const stagedTarget = join(staging, file.path);
        if (file.content === null) {
          await rm(stagedTarget, { force: true });
          continue;
        }
        await mkdir(dirname(stagedTarget), { recursive: true, mode: 0o700 });
        await writeFile(stagedTarget, file.content, {
          encoding: 'utf8',
          mode: 0o600,
        });
      }
      const validated = await loadAgentBundle(staging);
      if (!validated.snapshot) {
        throw new AppError(
          'invalid_input',
          validated.diagnostics[0]?.message ?? 'agent bundle is invalid',
        );
      }
      const backup = `${entry.dir}.backup-${randomUUID()}`;
      const restartWatcher = await this.closeProjectWatcher(projectId);
      try {
        await renameWithRetry(entry.dir, backup);
        try {
          await renameWithRetry(staging, entry.dir);
        } catch (error) {
          await renameWithRetry(backup, entry.dir);
          throw error;
        }
        await rm(backup, {
          recursive: true,
          force: true,
          maxRetries: 6,
          retryDelay: 100,
        });
      } finally {
        if (restartWatcher) this.watchProject(projectId);
      }
    } finally {
      await rm(staging, {
        recursive: true,
        force: true,
        maxRetries: 6,
        retryDelay: 100,
      });
    }
    await this.reloadEntry(
      projectId,
      'project',
      slugFromId(agentId),
      entry.dir,
      false,
    );
    this.deps.emitChanged?.(
      projectId,
      agentId,
      this.cache.get(agentId)?.snapshot ? 'changed' : 'validation',
    );
    return this.get(projectId, agentId);
  }

  async delete(projectId: string, agentId: string): Promise<void> {
    await this.ensureLoaded(projectId);
    const entry = this.requireEntry(projectId, agentId);
    if (entry.origin !== 'project')
      throw new AppError('conflict', 'built-in agents cannot be deleted');
    if (await this.deps.isAgentReferenced?.(projectId, agentId))
      throw new AppError('conflict', 'agent is referenced by a scheduled task');
    await this.deps.trashItem(entry.dir);
    this.cache.delete(agentId);
    this.deps.emitChanged?.(projectId, agentId, 'deleted');
  }

  async stop(): Promise<void> {
    for (const timer of this.debounce.values()) clearTimeout(timer);
    this.debounce.clear();
    await Promise.allSettled(
      [...this.watchers.values()].map((watcher) => watcher.close()),
    );
    this.watchers.clear();
  }

  private async ensureLoaded(projectId: string): Promise<void> {
    if (![...this.cache.values()].some((entry) => entry.origin === 'builtin'))
      await this.loadRoot(
        null,
        'builtin',
        this.deps.builtinsRoot ?? builtinAgentsDir(),
      );
    if (
      ![...this.cache.values()].some((entry) => entry.projectId === projectId)
    )
      await this.loadRoot(projectId, 'project', this.projectRoot(projectId));
    if (!this.watchers.has(projectId)) this.watchProject(projectId);
  }

  private watchProject(projectId: string): void {
    const watcher = chokidar.watch(this.projectRoot(projectId), {
      ignoreInitial: true,
      depth: 3,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    watcher.on('all', () => this.scheduleReload(projectId));
    this.watchers.set(projectId, watcher);
  }

  private async closeProjectWatcher(projectId: string): Promise<boolean> {
    const timer = this.debounce.get(projectId);
    if (timer !== undefined) clearTimeout(timer);
    this.debounce.delete(projectId);
    const watcher = this.watchers.get(projectId);
    if (watcher === undefined) return false;
    this.watchers.delete(projectId);
    await watcher.close();
    return true;
  }

  private scheduleReload(projectId: string): void {
    const prior = this.debounce.get(projectId);
    if (prior) clearTimeout(prior);
    this.debounce.set(
      projectId,
      setTimeout(() => {
        void this.loadRoot(
          projectId,
          'project',
          this.projectRoot(projectId),
          true,
        ).then(() => this.deps.emitChanged?.(projectId, undefined, 'changed'));
      }, 200),
    );
  }

  private async loadRoot(
    projectId: string | null,
    origin: MetaAgentOrigin,
    root: string,
    removeMissing = true,
  ): Promise<void> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const entries = await readdir(root, { withFileTypes: true });
    const seen = new Set<string>();
    for (const item of entries) {
      if (
        !item.isDirectory() ||
        !SLUG.test(item.name) ||
        item.name.includes('.staging-')
      )
        continue;
      seen.add(stableId(origin, projectId, item.name));
      await this.reloadEntry(
        projectId,
        origin,
        item.name,
        join(root, item.name),
        false,
      );
    }
    if (removeMissing)
      for (const [id, entry] of this.cache)
        if (
          entry.origin === origin &&
          entry.projectId === projectId &&
          !seen.has(id)
        )
          this.cache.delete(id);
  }

  private async reloadEntry(
    projectId: string | null,
    origin: MetaAgentOrigin,
    slug: string,
    dir: string,
    replaceInvalid: boolean,
  ): Promise<void> {
    const id = stableId(origin, projectId, slug);
    const result = await loadAgentBundle(dir);
    const prior = this.cache.get(id);
    this.cache.set(id, {
      id,
      projectId,
      origin,
      dir,
      snapshot:
        result.snapshot ?? (!replaceInvalid ? prior?.snapshot : undefined),
      diagnostics: result.diagnostics,
      files: result.files.length ? result.files : (prior?.files ?? []),
    });
  }

  private summary(
    entry: RegistryEntry,
    providers: { id: HarnessId; installed: boolean; authenticated: boolean }[],
  ): MetaAgentSummary {
    const snapshot = entry.snapshot;
    const availableProviders = new Set(
      providers
        .filter((provider) => provider.installed && provider.authenticated)
        .map((provider) => provider.id),
    );
    const required = snapshot?.requiredProviders ?? [];
    const unavailableReasons = required
      .filter((id) => !availableProviders.has(id))
      .map((id) => `${id} is not installed and authenticated`);
    return {
      id: entry.id,
      projectId: entry.projectId,
      slug: snapshot?.slug ?? slugFromId(entry.id),
      origin: entry.origin,
      name: snapshot?.name ?? slugFromId(entry.id),
      description: snapshot?.description ?? '',
      revision: snapshot?.revision ?? '',
      // A watcher reload retains the last validated snapshot while surfacing draft
      // diagnostics. That retained revision remains runnable until a valid save lands.
      valid: snapshot !== undefined,
      diagnostics: entry.diagnostics,
      requiredProviders: required,
      capabilities: snapshot?.capabilities ?? [],
      available: snapshot !== undefined && unavailableReasons.length === 0,
      unavailableReasons,
      editable: entry.origin === 'project',
      ...(snapshot?.protocol ? { protocol: snapshot.protocol } : {}),
    };
  }

  private requireEntry(projectId: string, agentId: string): RegistryEntry {
    const entry = this.cache.get(agentId);
    if (!entry || (entry.projectId !== null && entry.projectId !== projectId))
      throw new AppError('not_found', 'agent not found', { agentId });
    return entry;
  }

  private projectRoot(projectId: string): string {
    return (this.deps.projectRoot ?? projectAgentsDir)(projectId);
  }
  private assertSlug(slug: string): void {
    if (!SLUG.test(slug))
      throw new AppError(
        'invalid_input',
        'slug must contain lowercase letters, numbers, and hyphens',
      );
  }
  private async exists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch {
      return false;
    }
  }
  private async assertAbsent(path: string): Promise<void> {
    if (await this.exists(path))
      throw new AppError('conflict', 'agent slug already exists');
  }
  private async validateAndPublish(
    staging: string,
    target: string,
  ): Promise<void> {
    const result = await loadAgentBundle(staging);
    if (!result.snapshot)
      throw new AppError(
        'invalid_input',
        result.diagnostics[0]?.message ?? 'invalid agent bundle',
      );
    await rename(staging, target);
  }
  private async rejectSymlinks(root: string): Promise<void> {
    for (const item of await readdir(root, {
      withFileTypes: true,
      recursive: true,
    })) {
      if (item.isSymbolicLink())
        throw new AppError(
          'invalid_input',
          'agent imports cannot contain symbolic links',
        );
    }
  }
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  const retries = process.platform === 'win32' ? 6 : 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        attempt >= retries ||
        (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')
      ) {
        throw error;
      }
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, 50 * (attempt + 1)),
      );
    }
  }
}
