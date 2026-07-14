// Provider-neutral normalization for tools that pause to ask the user something.
// Keeping this pure lets both CLI adapters share the exact same classification rules.

import type { AgentEvent, AgentQuestion } from '@shared/harness';

/** Convert a known interaction tool into a structured event; unknown tools stay generic. */
export function normalizeInteractionTool(
  name: string,
  input: unknown,
  requestId?: string,
): AgentEvent | undefined {
  const canonical = name.replace(/[^a-z0-9]/gi, '').toLowerCase();

  if (
    canonical.endsWith('askuserquestion') ||
    canonical.endsWith('requestuserinput') ||
    canonical.endsWith('sendusermessage')
  ) {
    const questions = extractQuestions(input);
    if (questions.length > 0) {
      return { kind: 'question_request', requestId, questions };
    }
  }

  if (
    canonical.endsWith('permissionrequest') ||
    canonical.endsWith('requestpermission') ||
    canonical.endsWith('requestpermissions') ||
    canonical.endsWith('requestapproval') ||
    canonical.endsWith('requestapprovaldecision') ||
    canonical.endsWith('canusetool')
  ) {
    const record = asRecord(input);
    return {
      kind: 'permission_request',
      requestId,
      title: stringField(record, 'title'),
      description:
        stringField(record, 'description') ??
        stringField(record, 'reason') ??
        stringField(record, 'decision_reason'),
      toolName:
        stringField(record, 'toolName') ?? stringField(record, 'tool_name'),
      input: record?.input ?? input,
    };
  }

  return undefined;
}

export function extractQuestions(input: unknown): AgentQuestion[] {
  const record = asRecord(input);
  const rawQuestions = Array.isArray(record?.questions)
    ? record.questions
    : [input];
  const questions: AgentQuestion[] = [];

  for (const raw of rawQuestions) {
    const question = asRecord(raw);
    if (!question) continue;
    const text =
      stringField(question, 'question') ??
      stringField(question, 'prompt') ??
      stringField(question, 'message') ??
      stringField(question, 'text');
    if (!text) continue;

    const rawOptions = Array.isArray(question.options) ? question.options : [];
    const options = rawOptions.flatMap((option) => {
      if (typeof option === 'string') return [{ label: option }];
      const optionRecord = asRecord(option);
      const label =
        stringField(optionRecord, 'label') ??
        stringField(optionRecord, 'value');
      return label
        ? [
            {
              label,
              description: stringField(optionRecord, 'description'),
            },
          ]
        : [];
    });

    questions.push({
      id: stringField(question, 'id'),
      header: stringField(question, 'header'),
      question: text,
      multiSelect:
        typeof question.multiSelect === 'boolean'
          ? question.multiSelect
          : typeof question.multi_select === 'boolean'
            ? question.multi_select
            : undefined,
      options: options.length > 0 ? options : undefined,
    });
  }
  return questions;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
