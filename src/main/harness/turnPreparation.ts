import type {
  HarnessId,
  McpServerConfig,
  PermissionPolicy,
  StartTurnOpts,
  KnowledgeTurnStatusEvent,
} from '@shared/harness';
import type { Workspace } from '@shared/models';
import type { EffectiveSettings } from '@shared/settings';
import { AppError } from '@shared/errors';
import type { StoredProject } from '../db/repos/projects';
import type { WikiService } from '../knowledge';
import { KNOWLEDGE_RECONCILIATION_INSTRUCTION } from '../knowledge';
import {
  consumeKnowledgeTrace,
  prepareMcpTurnKnowledge,
  usesKnowledgeMcp,
} from '../knowledge/retrieval';

export type TurnOrigin =
  'manual' | 'scheduled' | 'meta-coordinator' | 'meta-child';

export type UnpreparedTurnOpts = Omit<
  StartTurnOpts,
  'mcpConfig' | 'permissionPolicy'
> & {
  mcpConfig?: McpServerConfig[];
  permissionPolicy?: PermissionPolicy;
};

export interface TurnPreparationDeps {
  getProject: (projectId: string) => Promise<StoredProject | null>;
  settingsForProject: (project: StoredProject) => Promise<EffectiveSettings>;
  knowledge: Pick<
    WikiService,
    'getConfig' | 'initializeProject' | 'contextSelectionForPrompt'
  >;
  warn: (message: string) => void;
}

const KNOWLEDGE_ORIGINS = new Set<TurnOrigin>([
  'manual',
  'scheduled',
  'meta-child',
]);

/**
 * Builds the final provider-neutral turn options for every project-backed producer.
 * The meta coordinator deliberately receives no project knowledge: its single control
 * MCP server is an authority boundary. Its children receive knowledge independently.
 */
export class TurnPreparationService {
  constructor(private readonly deps: TurnPreparationDeps) {}

  async prepareTurn(
    workspace: Workspace,
    rawOpts: UnpreparedTurnOpts,
    origin: TurnOrigin,
    harness: HarnessId = workspace.harness,
  ): Promise<StartTurnOpts> {
    const project = await this.deps.getProject(workspace.projectId);
    if (project === null) {
      throw new AppError('not_found', 'project not found', {
        projectId: workspace.projectId,
      });
    }
    const settings = await this.deps.settingsForProject(project);
    const mode = rawOpts.mode ?? settings.agent.mode;
    const baseMcp =
      rawOpts.mcpConfig ??
      (origin === 'manual' || origin === 'scheduled' ? settings.mcp : []);
    const shouldPrepareKnowledge =
      KNOWLEDGE_ORIGINS.has(origin) &&
      settings.knowledge.enabled &&
      settings.knowledge.inject_context;
    let knowledgeStatus: KnowledgeTurnStatusEvent = {
      kind: 'knowledge_status',
      status: 'not_configured',
      reason: 'disabled',
    };

    const config = shouldPrepareKnowledge
      ? await this.deps.knowledge.getConfig(workspace.projectId)
      : undefined;
    let knowledgeReady = false;
    if (config !== undefined) {
      try {
        await this.deps.knowledge.initializeProject(workspace.projectId);
        knowledgeReady = true;
      } catch {
        // Knowledge retrieval is an optional enrichment. Keep the turn usable and
        // retry initialization on its next preparation without logging local paths.
        this.deps.warn(
          `[knowledge] initialization unavailable for project ${workspace.projectId}; continuing without retrieval`,
        );
        knowledgeStatus = {
          kind: 'knowledge_status',
          status: 'failed',
          reason: 'initialization',
        };
      }
    }
    const searchEnabled = config?.search.enabled === true;
    const mcpKnowledge =
      config !== undefined &&
      knowledgeReady &&
      searchEnabled &&
      usesKnowledgeMcp(harness)
        ? prepareMcpTurnKnowledge(
            workspace.projectId,
            project.directoryName,
            config,
            settings.knowledge.search.max_context_tokens,
          )
        : undefined;

    if (mcpKnowledge !== undefined) {
      knowledgeStatus = {
        kind: 'knowledge_status',
        status: 'prepared',
        provider: config?.search.provider,
      };
    }

    try {
      const selection =
        shouldPrepareKnowledge && knowledgeReady && !usesKnowledgeMcp(harness)
          ? await this.deps.knowledge.contextSelectionForPrompt(
              workspace.projectId,
              rawOpts.prompt,
              Math.min(1_000, settings.knowledge.search.max_context_tokens),
              { maxResults: 2, catalogFallback: false },
            )
          : { context: '', sources: [], retrieval: undefined };
      const reconcile =
        KNOWLEDGE_ORIGINS.has(origin) &&
        settings.knowledge.enabled &&
        settings.knowledge.extract_after_turn &&
        mode !== 'plan';
      if (
        shouldPrepareKnowledge &&
        knowledgeReady &&
        !usesKnowledgeMcp(harness)
      ) {
        knowledgeStatus = eagerKnowledgeStatus(selection);
      }

      return {
        ...rawOpts,
        mode,
        permissionPolicy:
          rawOpts.permissionPolicy ?? settings.agent.permissionPolicy,
        mcpConfig:
          mcpKnowledge === undefined
            ? baseMcp
            : [...baseMcp, mcpKnowledge.server],
        knowledgeSources: selection.sources,
        ...(selection.retrieval === undefined
          ? {}
          : { knowledgeRetrieval: selection.retrieval }),
        ...(mcpKnowledge === undefined
          ? {}
          : { knowledgeTrace: mcpKnowledge.trace }),
        knowledgeStatus,
        prompt: [
          rawOpts.prompt,
          mcpKnowledge?.instruction ?? '',
          selection.context,
          reconcile ? KNOWLEDGE_RECONCILIATION_INSTRUCTION : '',
        ]
          .filter((part) => part !== '')
          .join('\n\n'),
      };
    } catch (error) {
      consumeKnowledgeTrace(mcpKnowledge?.trace);
      throw error;
    }
  }

  /** Release private MCP preparation state when no supervisor accepted the turn. */
  discard(opts: Pick<StartTurnOpts, 'knowledgeTrace'> | undefined): void {
    consumeKnowledgeTrace(opts?.knowledgeTrace);
  }
}

function eagerKnowledgeStatus(selection: {
  sources: unknown[];
  retrieval?: {
    providerUsed: 'qmd' | 'basic' | 'none';
    searchEnabled: boolean;
    searchStatus: 'disabled' | 'completed' | 'fallback' | 'failed';
  };
}): KnowledgeTurnStatusEvent {
  const retrieval = selection.retrieval;
  if (retrieval === undefined || !retrieval.searchEnabled) {
    return {
      kind: 'knowledge_status',
      status: 'not_configured',
      reason: 'disabled',
    };
  }
  if (retrieval.searchStatus === 'failed') {
    return {
      kind: 'knowledge_status',
      status: 'failed',
      provider: retrieval.providerUsed,
      reason: 'selection',
    };
  }
  if (retrieval.searchStatus === 'fallback') {
    return {
      kind: 'knowledge_status',
      status: 'fallback',
      provider: retrieval.providerUsed,
    };
  }
  return {
    kind: 'knowledge_status',
    status: selection.sources.length > 0 ? 'read' : 'no_results',
    provider: retrieval.providerUsed,
  };
}
