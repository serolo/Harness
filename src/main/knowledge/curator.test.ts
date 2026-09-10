import { describe, expect, it, vi } from 'vitest';
import { PostTurnKnowledgeCurator } from './curator';

describe('PostTurnKnowledgeCurator', () => {
  it.each([
    ['no blocks', 'All done.', 0],
    [
      'malformed JSON',
      '<harness_knowledge_proposal>{bad}</harness_knowledge_proposal>',
      1,
    ],
    [
      'invalid shape',
      '<harness_knowledge_proposal>{"title":"Missing operations"}</harness_knowledge_proposal>',
      1,
    ],
    [
      'truncated block',
      '<harness_knowledge_proposal>{"title":"Interrupted"',
      1,
    ],
    ['oversized output', 'x'.repeat(2_000_001), 1],
  ])('reports rejected count for %s', (_name, response, rejectedCount) => {
    const curator = new PostTurnKnowledgeCurator({ warn: vi.fn() });
    expect(curator.curateWithOutcome(response)).toEqual({
      proposals: [],
      rejectedCount,
    });
  });

  it('reports proposals dropped by the extraction limit', () => {
    const curator = new PostTurnKnowledgeCurator({ warn: vi.fn() });
    const payload = {
      title: 'Lesson',
      summary: 'A durable change.',
      operations: [
        {
          op: 'create',
          path: 'notes/example.md',
          content: '---\ntype: Note\n---\n# Lesson',
        },
      ],
    };
    const block = `<harness_knowledge_proposal>${JSON.stringify(payload)}</harness_knowledge_proposal>`;
    const outcome = curator.curateWithOutcome(block.repeat(10));
    expect(outcome.proposals).toHaveLength(8);
    expect(outcome.rejectedCount).toBe(2);
  });

  it('keeps the legacy hidden proposal protocol', () => {
    const curator = new PostTurnKnowledgeCurator({ warn: vi.fn() });
    const payload = {
      title: 'Record decision',
      summary: 'Records a durable choice.',
      operations: [
        {
          op: 'create',
          path: 'decisions/example.md',
          content: '---\ntype: Decision\n---\n# Example',
        },
      ],
    };

    expect(
      curator.curate(
        `<harness_knowledge_proposal>${JSON.stringify(payload)}</harness_knowledge_proposal>`,
      ),
    ).toEqual([payload]);
  });

  it('rejects oversized turn output without parsing it', () => {
    const warn = vi.fn();
    const curator = new PostTurnKnowledgeCurator({ warn });

    expect(curator.curate('x'.repeat(2_000_001))).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      '[knowledge:curator] response exceeded the curation limit',
    );
  });

  it('caps extraction at eight proposals even when more valid blocks are present', () => {
    const curator = new PostTurnKnowledgeCurator({ warn: vi.fn() });
    const response = Array.from({ length: 9 }, (_, index) => {
      const payload = {
        title: `Proposal ${index}`,
        summary: 'A durable change.',
        operations: [
          {
            op: 'create',
            path: `decisions/${index}.md`,
            content: '---\ntype: Decision\n---\n# Decision',
          },
        ],
      };
      return `<harness_knowledge_proposal>${JSON.stringify(payload)}</harness_knowledge_proposal>`;
    }).join('\n');

    expect(curator.curate(response).map((proposal) => proposal.title)).toEqual(
      Array.from({ length: 8 }, (_, index) => `Proposal ${index}`),
    );
  });

  it('rejects a proposal that exceeds operation or content bounds', () => {
    const warn = vi.fn();
    const curator = new PostTurnKnowledgeCurator({ warn });
    const tooManyOperations = {
      title: 'Too many changes',
      summary: 'Must remain bounded.',
      operations: Array.from({ length: 33 }, (_, index) => ({
        op: 'move',
        from: `old/${index}.md`,
        to: `new/${index}.md`,
      })),
    };
    const oversizedContent = {
      title: 'Too much content',
      summary: 'Must remain bounded.',
      operations: [
        {
          op: 'create',
          path: 'notes/large.md',
          content: 'x'.repeat(512_001),
        },
      ],
    };
    const block = (payload: object): string =>
      `<harness_knowledge_proposal>${JSON.stringify(payload)}</harness_knowledge_proposal>`;

    expect(
      curator.curate(`${block(tooManyOperations)}${block(oversizedContent)}`),
    ).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      '[knowledge:curator] ignored proposal with an invalid shape',
    );
    expect(warn).toHaveBeenNthCalledWith(
      2,
      '[knowledge:curator] ignored proposal with an invalid shape',
    );
  });
});
