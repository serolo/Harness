import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { NormalizedAgentSnapshot } from '@shared/agents';
import {
  parseSkillUsage,
  parseStoredSkillUsage,
  skillSnapshot,
  skillUsageInstruction,
} from './skillEvidence';

const content = 'Always inspect the migration first.';
const digest = createHash('sha256').update(content).digest('hex');
const snapshot = {
  skills: [{ slug: 'migration-guide', content, digest }],
} as NormalizedAgentSnapshot;

describe('meta skill evidence', () => {
  it('binds prompt instructions to exact immutable skill revisions', () => {
    expect(skillSnapshot(snapshot)).toEqual([
      { slug: 'migration-guide', digest },
    ]);
    expect(skillUsageInstruction(snapshot)).toContain(
      `migration-guide@${digest}`,
    );
  });

  it('accepts only a final footer matching an offered slug and full digest', () => {
    expect(
      parseSkillUsage(
        `Implemented safely.\nSkills consulted: migration-guide@${digest}`,
        snapshot,
      ),
    ).toEqual({
      summary: 'Implemented safely.',
      usage: {
        reported: true,
        skills: [{ slug: 'migration-guide', digest }],
      },
    });
    expect(
      parseSkillUsage(
        `Skills consulted: migration-guide@${'0'.repeat(64)}`,
        snapshot,
      ).usage.reported,
    ).toBe(false);
    expect(
      parseSkillUsage(
        `Skills consulted: migration-guide@${digest}\nMore text`,
        snapshot,
      ).usage.reported,
    ).toBe(false);
  });

  it('distinguishes explicit none from a missing or corrupt report', () => {
    expect(parseSkillUsage('Done\nSkills consulted: none', snapshot)).toEqual({
      summary: 'Done',
      usage: { reported: true, skills: [] },
    });
    expect(parseSkillUsage('Done', snapshot).usage.reported).toBe(false);
    expect(parseStoredSkillUsage('{broken')).toEqual({
      reported: false,
      skills: [],
    });
  });
});
