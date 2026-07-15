import type { PermissionCardProps } from './PermissionCard';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function textContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  const direct = stringField(record, 'text');
  if (direct !== undefined) return direct;
  const content = record?.content;
  if (!Array.isArray(content)) return undefined;
  return content.map(textContent).filter(Boolean).join('\n') || undefined;
}

function claudePermissionText(text: string): PermissionCardProps | null {
  const readMatch = /^Claude requested permissions to read from (.+), but you haven't granted it yet\.$/.exec(
    text,
  );
  if (readMatch) {
    return {
      title: 'File access requires approval',
      description: `The agent needs your approval to read from ${readMatch[1]}.`,
    };
  }

  const commandMatch = /^(.+) was blocked\. Claude Code requires approval before reading it\.$/.exec(
    text,
  );
  if (commandMatch) {
    return {
      title: 'File access requires approval',
      description: `The agent needs your approval before it can run ${commandMatch[1]}.`,
    };
  }

  return null;
}

export function permissionFromToolResult(
  output: unknown,
): PermissionCardProps | null {
  const text = textContent(output);
  if (text !== undefined) {
    const claudePermission = claudePermissionText(text);
    if (claudePermission !== null) return claudePermission;
  }

  if (
    typeof output === 'string' &&
    output.includes('requires approval before reading this file')
  ) {
    return {
      title: 'File access requires approval',
      description: output,
      toolName: 'Read',
      input: { message: output },
    };
  }

  const record = asRecord(output);
  const status = stringField(record, 'status') ?? stringField(record, 'code');
  if (status !== 'permission_denied' && status !== 'requires_approval') {
    return null;
  }
  return {
    title: stringField(record, 'title') ?? 'Permission requested',
    description: stringField(record, 'message') ?? stringField(record, 'reason'),
    toolName: stringField(record, 'toolName') ?? stringField(record, 'tool_name'),
    input: record?.input,
  };
}
