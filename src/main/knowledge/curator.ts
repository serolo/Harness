import type {
  CreateWikiProposalInput,
  WikiOperation,
} from '@shared/knowledge';

const PROPOSAL_OPEN = '<harness_knowledge_proposal>';
const PROPOSAL_CLOSE = '</harness_knowledge_proposal>';
const MAX_RESPONSE_CHARACTERS = 2_000_000;
const MAX_PROPOSALS = 8;
const MAX_OPERATIONS = 32;
const MAX_CONTENT_CHARACTERS = 512_000;

export interface CuratedKnowledgeProposal {
  title: string;
  summary: string;
  operations: WikiOperation[];
}

export interface KnowledgeCuratorLogger {
  warn(message: string): void;
}

function isOperation(value: unknown): value is WikiOperation {
  if (typeof value !== 'object' || value === null) return false;
  const operation = value as Record<string, unknown>;
  if (operation.op === 'move') {
    return typeof operation.from === 'string' && typeof operation.to === 'string';
  }
  return (
    (operation.op === 'create' || operation.op === 'update') &&
    typeof operation.path === 'string' &&
    typeof operation.content === 'string' &&
    operation.content.length <= MAX_CONTENT_CHARACTERS
  );
}

/**
 * Bounded post-turn curation seam.
 *
 * Provider-specific curators can be introduced behind this interface later. For now it
 * preserves the legacy hidden-block protocol while keeping untrusted model output out
 * of the lifecycle orchestration and enforcing strict work limits.
 */
export class PostTurnKnowledgeCurator {
  constructor(private readonly log: KnowledgeCuratorLogger) {}

  curate(responseText: string): CuratedKnowledgeProposal[] {
    if (responseText.length > MAX_RESPONSE_CHARACTERS) {
      this.log.warn('[knowledge:curator] response exceeded the curation limit');
      return [];
    }

    const proposals: CuratedKnowledgeProposal[] = [];
    const pattern = new RegExp(
      `${PROPOSAL_OPEN}([\\s\\S]*?)${PROPOSAL_CLOSE}`,
      'g',
    );
    let match: RegExpExecArray | null;
    while (
      proposals.length < MAX_PROPOSALS &&
      (match = pattern.exec(responseText)) !== null
    ) {
      try {
        const parsed = JSON.parse(match[1].trim()) as Partial<
          CreateWikiProposalInput
        >;
        if (
          typeof parsed.title !== 'string' ||
          typeof parsed.summary !== 'string' ||
          !Array.isArray(parsed.operations) ||
          parsed.operations.length === 0 ||
          parsed.operations.length > MAX_OPERATIONS ||
          !parsed.operations.every(isOperation)
        ) {
          this.log.warn('[knowledge:curator] ignored proposal with an invalid shape');
          continue;
        }
        proposals.push({
          title: parsed.title,
          summary: parsed.summary,
          operations: parsed.operations,
        });
      } catch {
        // Do not include the parser error: model output can contain sensitive content.
        this.log.warn('[knowledge:curator] ignored invalid proposal JSON');
      }
    }
    return proposals;
  }
}
