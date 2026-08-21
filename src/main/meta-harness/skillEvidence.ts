import { createHash } from 'node:crypto';
import type {
  MetaSkillEvidence,
  MetaSkillUsageReport,
  NormalizedAgentSnapshot,
} from '@shared/agents';

const FOOTER_PREFIX = 'Skills consulted:';

export function skillSnapshot(
  snapshot: NormalizedAgentSnapshot,
): MetaSkillEvidence[] {
  return snapshot.skills.map(({ slug, content, digest }) => ({
    slug,
    digest: digest ?? createHash('sha256').update(content).digest('hex'),
  }));
}

export function skillUsageInstruction(
  snapshot: NormalizedAgentSnapshot,
): string {
  const offered = skillSnapshot(snapshot);
  if (offered.length === 0) {
    return `End your final response with exactly \`${FOOTER_PREFIX} none\`.`;
  }
  return [
    'End your final response with one structured skill-usage footer.',
    `Use \`${FOOTER_PREFIX} none\` if you consulted none of the supplied skills.`,
    `Otherwise use \`${FOOTER_PREFIX} slug@<full-sha256>, other@<full-sha256>\`.`,
    `Only report these immutable skill revisions: ${offered
      .map(({ slug, digest }) => `${slug}@${digest}`)
      .join(', ')}.`,
  ].join('\n');
}

export function parseSkillUsage(
  text: string,
  snapshot: NormalizedAgentSnapshot,
): { summary: string; usage: MetaSkillUsageReport } {
  const trimmed = text.trimEnd();
  const lines = trimmed.split('\n');
  const footer = lines.at(-1)?.trim() ?? '';
  if (!footer.startsWith(FOOTER_PREFIX)) {
    return { summary: text, usage: { reported: false, skills: [] } };
  }

  const payload = footer.slice(FOOTER_PREFIX.length).trim();
  if (payload === 'none') {
    return {
      summary: lines.slice(0, -1).join('\n').trimEnd(),
      usage: { reported: true, skills: [] },
    };
  }

  const available = new Map(
    skillSnapshot(snapshot).map((skill) => [skill.slug, skill.digest]),
  );
  const tokens = payload.split(',').map((token) => token.trim());
  const skills: MetaSkillEvidence[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const match = /^([a-z0-9](?:[a-z0-9-]{0,62}))@([a-f0-9]{64})$/.exec(token);
    if (!match || available.get(match[1]) !== match[2] || seen.has(match[1])) {
      return { summary: text, usage: { reported: false, skills: [] } };
    }
    seen.add(match[1]);
    skills.push({ slug: match[1], digest: match[2] });
  }
  if (skills.length === 0) {
    return { summary: text, usage: { reported: false, skills: [] } };
  }
  return {
    summary: lines.slice(0, -1).join('\n').trimEnd(),
    usage: { reported: true, skills },
  };
}

export function serializeSkillUsage(report: MetaSkillUsageReport): string {
  return JSON.stringify(report);
}

export function parseStoredSkillUsage(json: string): MetaSkillUsageReport {
  try {
    if (Buffer.byteLength(json, 'utf8') > 16_384) throw new Error('too large');
    const value = JSON.parse(json) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('invalid');
    const report = value as { reported?: unknown; skills?: unknown };
    if (
      typeof report.reported !== 'boolean' ||
      !Array.isArray(report.skills) ||
      report.skills.length > 128
    )
      throw new Error('invalid');
    const skills = report.skills.map((candidate) => {
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate)
      )
        throw new Error('invalid');
      const skill = candidate as { slug?: unknown; digest?: unknown };
      if (
        typeof skill.slug !== 'string' ||
        !/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(skill.slug) ||
        typeof skill.digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(skill.digest)
      )
        throw new Error('invalid');
      return { slug: skill.slug, digest: skill.digest };
    });
    return { reported: report.reported, skills };
  } catch {
    return { reported: false, skills: [] };
  }
}
