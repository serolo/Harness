import type { PermissionCardProps } from './PermissionCard';

/**
 * Tool results are protocol traffic, not chat messages. The one renderer-relevant
 * exception is a result explaining that an action was blocked for approval: convert
 * that into permission-card copy without exposing the raw result payload.
 */
export function permissionFromToolResult(
  output: unknown,
): PermissionCardProps | null {
  const message = extractText(output).replace(/\s+/g, ' ').trim();
  if (message === '' || !looksLikePermissionBlock(message)) return null;

  const requestedAction = message.match(
    /requested permissions? to (.+?)(?:,\s*but\b|$)/i,
  )?.[1];
  if (requestedAction) {
    return {
      title: permissionTitle(requestedAction),
      description: `The agent needs your approval to ${truncate(requestedAction)}.`,
    };
  }

  const blockedAction = message.match(
    /(.{1,180}?) was blocked(?:[.!?]|$)/i,
  )?.[1];
  if (blockedAction) {
    return {
      title: permissionTitle(blockedAction),
      description: `The agent needs your approval before it can run ${truncate(blockedAction)}.`,
    };
  }

  return {
    title: 'Permission required',
    description: 'The agent needs your approval before it can continue.',
  };
}

function looksLikePermissionBlock(message: string): boolean {
  return (
    /haven['’]t granted/i.test(message) ||
    /has not been granted/i.test(message) ||
    /requires? (?:your )?approval/i.test(message) ||
    /permission (?:was )?denied/i.test(message) ||
    /requested permissions?/i.test(message) ||
    (/\bwas blocked\b/i.test(message) &&
      /\b(?:approval|permission|security)\b/i.test(message))
  );
}

function permissionTitle(action: string): string {
  if (/\b(?:read|cat|open)\b/i.test(action))
    return 'File access requires approval';
  if (/\b(?:write|edit|create|delete|remove)\b/i.test(action)) {
    return 'File change requires approval';
  }
  return 'Command requires approval';
}

function truncate(value: string): string {
  const clean = value.trim();
  return clean.length <= 160 ? clean : `${clean.slice(0, 157)}…`;
}

/** Extract only human-readable text from common Claude/Codex result envelopes. */
function extractText(value: unknown, depth = 0): string {
  if (depth > 3) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => extractText(item, depth + 1)).join(' ');
  }
  if (typeof value !== 'object' || value === null) return '';

  const record = value as Record<string, unknown>;
  return ['text', 'message', 'content', 'error', 'output']
    .map((key) => extractText(record[key], depth + 1))
    .filter(Boolean)
    .join(' ');
}
