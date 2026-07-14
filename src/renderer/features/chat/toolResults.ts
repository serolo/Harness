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

export function permissionFromToolResult(
  output: unknown,
): PermissionCardProps | null {
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
