import type { AgentEvent, AgentQuestion } from '@shared/harness';

export function asRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function normalizeInteractionTool(
  name: string,
  input: unknown,
  requestId?: string,
): AgentEvent | null {
  const normalized = name.toLowerCase();
  if (
    normalized !== 'request_user_input' &&
    normalized !== 'requestuserinput' &&
    normalized !== 'askuserquestion'
  ) {
    return null;
  }

  const record = asRecord(input);
  const rawQuestions = Array.isArray(record?.questions)
    ? record.questions
    : [input];
  const questions = rawQuestions.flatMap((raw): AgentQuestion[] => {
    const question = asRecord(raw);
    const text = stringField(question, 'question');
    if (!text) return [];
    const options = Array.isArray(question?.options)
      ? question.options.flatMap((rawOption) => {
          const option = asRecord(rawOption);
          const label = stringField(option, 'label');
          return label
            ? [
                {
                  label,
                  description: stringField(option, 'description'),
                },
              ]
            : [];
        })
      : undefined;
    return [
      {
        id: stringField(question, 'id'),
        header: stringField(question, 'header'),
        question: text,
        multiSelect:
          typeof question?.multiSelect === 'boolean'
            ? question.multiSelect
            : undefined,
        options,
      },
    ];
  });

  return questions.length > 0
    ? { kind: 'question_request', requestId, questions }
    : null;
}
