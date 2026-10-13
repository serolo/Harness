import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, RefreshCw, Search, Sparkles } from 'lucide-react';
import type { SlashCommand } from '@shared/slash';
import {
  Button,
  Dialog,
  Input,
  Select,
  Textarea,
} from '@renderer/components/ui';
import { invoke } from '@renderer/ipc';
import { useComposerStore } from '@renderer/stores/composer';

type SkillProvider = 'claude_code' | 'codex';
type SkillProviderFilter = SkillProvider | 'all';

interface AvailableSkill {
  key: string;
  name: string;
  description: string;
  provenance: NonNullable<SlashCommand['provenance']> | 'unknown';
  providers: SkillProvider[];
}

type SkillScopeFilter = AvailableSkill['provenance'] | 'all';

const PROVIDER_LABEL: Record<SkillProvider, string> = {
  claude_code: 'Claude',
  codex: 'Codex',
};

const PROVENANCE_LABEL: Record<AvailableSkill['provenance'], string> = {
  workspace: 'Workspace',
  repository: 'Repository',
  user: 'Personal',
  admin: 'Managed',
  app: 'Harness',
  unknown: 'Available',
};

const PROVENANCE_ORDER: Record<AvailableSkill['provenance'], number> = {
  workspace: 0,
  repository: 1,
  user: 2,
  admin: 3,
  app: 4,
  unknown: 5,
};

const SKILL_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;

const PROVIDER_FILTER_OPTIONS = [
  { value: 'all', label: 'All providers' },
  { value: 'claude_code', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
];

const SCOPE_FILTER_OPTIONS = [
  { value: 'all', label: 'All scopes' },
  { value: 'workspace', label: 'Workspace' },
  { value: 'repository', label: 'Repository' },
  { value: 'user', label: 'Personal' },
  { value: 'admin', label: 'Managed' },
  { value: 'app', label: 'Harness' },
  { value: 'unknown', label: 'Other' },
];

/** Consolidate matching Claude/Codex copies while retaining same-name scope collisions. */
export function mergeNativeSkills(
  commands: readonly SlashCommand[],
): AvailableSkill[] {
  const grouped = new Map<string, AvailableSkill[]>();
  for (const command of commands) {
    const provider = command.provider;
    if (
      command.source !== 'native_skill' ||
      (provider !== 'claude_code' && provider !== 'codex')
    ) {
      continue;
    }
    const provenance = command.provenance ?? 'unknown';
    const groupKey = `${command.name}:${provenance}`;
    const group = grouped.get(groupKey) ?? [];
    const current = group.find((skill) => !skill.providers.includes(provider));
    if (current) {
      current.providers.push(provider);
      continue;
    }
    group.push({
      key: `${groupKey}:${group.length}`,
      name: command.name,
      description: command.description?.trim() || 'Reusable agent instructions',
      provenance,
      providers: [provider],
    });
    grouped.set(groupKey, group);
  }
  return [...grouped.values()]
    .flat()
    .map((skill) => ({
      ...skill,
      providers: [...skill.providers].sort(),
    }))
    .sort(
      (left, right) =>
        PROVENANCE_ORDER[left.provenance] -
          PROVENANCE_ORDER[right.provenance] ||
        left.name.localeCompare(right.name),
    );
}

export function filterSkills(
  skills: readonly AvailableSkill[],
  query: string,
  provider: SkillProviderFilter,
  scope: SkillScopeFilter,
): AvailableSkill[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return skills.filter(
    (skill) =>
      (normalizedQuery === '' ||
        skill.name.toLocaleLowerCase().includes(normalizedQuery) ||
        skill.description.toLocaleLowerCase().includes(normalizedQuery)) &&
      (provider === 'all' || skill.providers.includes(provider)) &&
      (scope === 'all' || skill.provenance === scope),
  );
}

export function skillCreationPrompt(slug: string, purpose: string): string {
  return `Create a reusable, repository-scoped agent skill named \`${slug}\` for this project.

Goal:
${purpose.trim()}

Create matching provider-native files so the skill works from both Claude Code and Codex:
- \`.claude/skills/${slug}/SKILL.md\`
- \`.agents/skills/${slug}/SKILL.md\`

Requirements:
- Inspect the repository instructions and the nearest existing skills before writing.
- Use YAML frontmatter with \`name: ${slug}\` and a concise, trigger-oriented \`description\`.
- Keep the core workflow and supporting resources in provider parity; add provider-specific metadata only when required.
- Scope the instructions narrowly, make steps testable, and reference scripts/templates instead of duplicating large content.
- Do not modify unrelated files or overwrite an existing same-name skill without first explaining the conflict.
- Validate both skill copies and summarize the files created so I can review them in Git.`;
}

export function SkillsPanel({
  workspaceId,
}: {
  workspaceId: string | null;
}): React.JSX.Element {
  const setPendingPrompt = useComposerStore((state) => state.setPendingPrompt);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [slug, setSlug] = useState('');
  const [purpose, setPurpose] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [providerFilter, setProviderFilter] =
    useState<SkillProviderFilter>('all');
  const [scopeFilter, setScopeFilter] = useState<SkillScopeFilter>('all');
  const loadRequest = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const request = ++loadRequest.current;
    if (!workspaceId) {
      setCommands([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [claude, codex] = await Promise.all([
        invoke('slash:list', { workspaceId, harness: 'claude_code' }),
        invoke('slash:list', { workspaceId, harness: 'codex' }),
      ]);
      if (request === loadRequest.current) {
        setCommands([...claude, ...codex]);
      }
    } catch (reason) {
      if (request !== loadRequest.current) return;
      setCommands([]);
      setError(
        reason instanceof Error ? reason.message : 'Could not load skills.',
      );
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
    return () => {
      loadRequest.current += 1;
    };
  }, [load]);

  const skills = useMemo(() => mergeNativeSkills(commands), [commands]);
  const filteredSkills = useMemo(
    () => filterSkills(skills, searchQuery, providerFilter, scopeFilter),
    [providerFilter, scopeFilter, searchQuery, skills],
  );
  const hasFilters =
    searchQuery.trim() !== '' ||
    providerFilter !== 'all' ||
    scopeFilter !== 'all';

  const clearFilters = (): void => {
    setSearchQuery('');
    setProviderFilter('all');
    setScopeFilter('all');
  };

  if (!workspaceId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-fg-3">
        Select a workspace to view its skills.
      </div>
    );
  }

  const openCreator = (): void => {
    setSlug('');
    setPurpose('');
    setValidationError(null);
    setPrepared(false);
    setCreatorOpen(true);
  };

  const prepareWithAgent = (): void => {
    const normalizedSlug = slug.trim().toLowerCase();
    if (!SKILL_SLUG.test(normalizedSlug)) {
      setValidationError(
        'Use 1–63 lowercase letters, numbers, and hyphens; start with a letter or number.',
      );
      return;
    }
    if (purpose.trim() === '') {
      setValidationError(
        'Describe when the skill should be used and what it should do.',
      );
      return;
    }
    setPendingPrompt(workspaceId, skillCreationPrompt(normalizedSlug, purpose));
    setPrepared(true);
    setCreatorOpen(false);
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="skills-panel"
    >
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border-1 px-3 py-3">
        <div>
          <h3 className="text-sm font-semibold text-fg-1">Available skills</h3>
          <p className="mt-1 text-2xs leading-4 text-fg-3">
            Type / in chat to search this catalogue. Codex skills switch to
            their native $ invocation when selected.
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            size="sm"
            variant="ghost"
            aria-label="Refresh skills"
            data-testid="skills-refresh"
            onClick={() => void load()}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <Button
            size="sm"
            variant="primary"
            data-testid="skill-new"
            onClick={openCreator}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            New skill
          </Button>
        </div>
      </div>

      {prepared ? (
        <div
          className="mx-3 mt-3 rounded-2 border border-accent-border bg-bg-3 px-3 py-2 text-xs text-fg-2"
          data-testid="skill-prompt-prepared"
        >
          The creation request is ready in chat. Review it, then send it to your
          agent.
        </div>
      ) : null}

      <div
        className="shrink-0 border-b border-border-1 px-3 py-2.5"
        data-testid="skills-filters"
      >
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3"
            aria-hidden
          />
          <Input
            className="w-full pl-8"
            type="search"
            value={searchQuery}
            placeholder="Search skills"
            aria-label="Search skills"
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </div>
        <div className="mt-2 flex gap-2">
          <Select
            className="min-w-0 flex-1"
            aria-label="Filter skills by provider"
            value={providerFilter}
            options={PROVIDER_FILTER_OPTIONS}
            onChange={(event) =>
              setProviderFilter(event.target.value as SkillProviderFilter)
            }
          />
          <Select
            className="min-w-0 flex-1"
            aria-label="Filter skills by scope"
            value={scopeFilter}
            options={SCOPE_FILTER_OPTIONS}
            onChange={(event) =>
              setScopeFilter(event.target.value as SkillScopeFilter)
            }
          />
        </div>
        <div className="mt-2 flex items-center justify-between text-2xs text-fg-3">
          <span aria-live="polite" data-testid="skills-result-count">
            {filteredSkills.length} of {skills.length}{' '}
            {skills.length === 1 ? 'skill' : 'skills'}
          </span>
          {hasFilters ? (
            <button
              type="button"
              className="font-medium text-fg-2 hover:text-fg-1"
              data-testid="skills-clear-filters"
              onClick={clearFilters}
            >
              Clear filters
            </button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="p-5 text-center text-sm text-fg-3">
            Loading skills…
          </div>
        ) : error ? (
          <div className="p-5 text-center text-sm text-danger">{error}</div>
        ) : skills.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-fg-3">
            <Sparkles className="h-5 w-5" aria-hidden />
            <p>No native skills found for this workspace.</p>
            <p className="text-2xs">Create one with an agent to get started.</p>
          </div>
        ) : filteredSkills.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-fg-3">
            <Search className="h-5 w-5" aria-hidden />
            <p>No skills match your search and filters.</p>
            <p className="text-2xs">Adjust or clear the filters above.</p>
          </div>
        ) : (
          filteredSkills.map((skill) => (
            <article
              key={skill.key}
              className="mb-2 rounded-3 border border-border-1 bg-surface-panel p-3"
              data-testid={`skill-${skill.key.replaceAll(':', '-')}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="truncate font-mono text-xs font-semibold text-fg-1">
                    /{skill.name}
                  </h4>
                  <p className="mt-1 line-clamp-2 text-xs leading-4 text-fg-3">
                    {skill.description}
                  </p>
                </div>
                <span className="shrink-0 text-2xs uppercase text-fg-3">
                  {PROVENANCE_LABEL[skill.provenance]}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {skill.providers.map((provider) => (
                  <span
                    key={provider}
                    className="rounded-1 bg-bg-3 px-1.5 py-0.5 text-2xs text-fg-3"
                  >
                    {PROVIDER_LABEL[provider]}
                  </span>
                ))}
              </div>
            </article>
          ))
        )}
      </div>

      {creatorOpen ? (
        <Dialog
          title="Create a skill with an agent"
          onClose={() => setCreatorOpen(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setCreatorOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                data-testid="skill-prepare"
                onClick={prepareWithAgent}
              >
                Prepare in chat
              </Button>
            </>
          }
        >
          <p className="mb-4 text-sm leading-5 text-fg-3">
            Harness will prepare a request for the current chat. The agent will
            create matching, source-controlled Claude and Codex skill files.
          </p>
          <label className="block text-xs font-medium text-fg-2">
            Skill name
            <Input
              autoFocus
              mono
              className="mt-1 w-full"
              placeholder="release-checklist"
              value={slug}
              aria-label="Skill name"
              onChange={(event) => {
                setSlug(event.target.value);
                setValidationError(null);
              }}
            />
          </label>
          <label className="mt-4 block text-xs font-medium text-fg-2">
            What should this skill do?
            <Textarea
              className="mt-1 w-full"
              rows={5}
              placeholder="Describe its trigger, workflow, inputs, and expected result."
              value={purpose}
              aria-label="Skill purpose"
              onChange={(event) => {
                setPurpose(event.target.value);
                setValidationError(null);
              }}
            />
          </label>
          {validationError ? (
            <p className="mt-2 text-xs text-danger" role="alert">
              {validationError}
            </p>
          ) : null}
        </Dialog>
      ) : null}
    </div>
  );
}
