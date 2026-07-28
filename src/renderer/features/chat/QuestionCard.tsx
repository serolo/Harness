import { useState } from 'react';
import type { AgentQuestion } from '@shared/harness';
import { Card } from '@renderer/components/ui';

export function QuestionCard({
  questions,
  disabled = false,
  onSubmit,
}: {
  questions: AgentQuestion[];
  disabled?: boolean;
  onSubmit?: (answer: string) => void;
}): React.JSX.Element {
  const [answers, setAnswers] = useState<Record<number, string[]>>({});

  const complete = questions.every(
    (_question, index) => (answers[index]?.length ?? 0) > 0,
  );

  const submit = (): void => {
    if (!complete || !onSubmit) return;
    const answer = questions
      .map((question, index) => {
        const value = answers[index]!.join(', ');
        return questions.length === 1
          ? value
          : `${question.header ?? question.question}: ${value}`;
      })
      .join('\n');
    onSubmit(answer);
  };

  return (
    <Card data-testid="question-card" title="Question">
      <div className="space-y-3 text-sm text-fg-2">
        {questions.map((question, index) => (
          <div key={question.id ?? index} className="space-y-2">
            {question.header ? (
              <div className="text-xs font-medium uppercase tracking-caps text-fg-3">
                {question.header}
              </div>
            ) : null}
            <div className="font-medium text-fg-1">{question.question}</div>
            {question.options && question.options.length > 0 ? (
              <div className="flex flex-wrap gap-2" role="group">
                {question.options.map((option) => (
                  <button
                    type="button"
                    key={option.label}
                    disabled={disabled || !onSubmit}
                    aria-pressed={answers[index]?.includes(option.label) ?? false}
                    className="rounded-2 border border-border-1 px-2 py-1 text-left text-xs enabled:hover:border-accent enabled:hover:text-fg-1 aria-pressed:border-accent aria-pressed:bg-accent/10 aria-pressed:text-fg-1 disabled:cursor-default"
                    onClick={() =>
                      setAnswers((current) => {
                        const selected = current[index] ?? [];
                        return {
                          ...current,
                          [index]: question.multiSelect
                            ? selected.includes(option.label)
                              ? selected.filter((item) => item !== option.label)
                              : [...selected, option.label]
                            : [option.label],
                        };
                      })
                    }
                  >
                    {option.label}
                    {option.description ? ` - ${option.description}` : ''}
                  </button>
                ))}
              </div>
            ) : onSubmit ? (
              <textarea
                rows={2}
                disabled={disabled}
                aria-label={question.question}
                className="w-full resize-y rounded-1 border border-border-1 bg-surface-well px-2 py-1.5 text-sm text-fg-1 outline-none focus:border-accent disabled:opacity-60"
                value={answers[index]?.[0] ?? ''}
                onChange={(event) =>
                  setAnswers((current) => ({
                    ...current,
                    [index]: event.target.value.trim()
                      ? [event.target.value]
                      : [],
                  }))
                }
              />
            ) : null}
          </div>
        ))}
        {onSubmit ? (
          <button
            type="button"
            data-testid="question-submit"
            disabled={disabled || !complete}
            className="rounded-1 bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
            onClick={submit}
          >
            Reply
          </button>
        ) : null}
      </div>
    </Card>
  );
}
