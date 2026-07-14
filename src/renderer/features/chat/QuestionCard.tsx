import { CircleHelp } from 'lucide-react';
import type { AgentQuestion } from '@shared/harness';

export interface QuestionCardProps {
  questions: AgentQuestion[];
}

/** A conversational prompt from the model, visually separate from tool activity. */
export function QuestionCard({
  questions,
}: QuestionCardProps): React.JSX.Element {
  return (
    <section
      className="overflow-hidden rounded-4 border border-accent-border bg-accent-muted"
      data-testid="question-card"
      aria-label="Question from the agent"
    >
      <div className="flex items-center gap-2 border-b border-accent-border px-5 py-3 text-sm font-semibold text-fg-1">
        <CircleHelp className="h-4 w-4 text-accent" aria-hidden />
        Agent has a question
      </div>
      <div className="space-y-5 px-5 py-4">
        {questions.map((question, index) => (
          <div key={question.id ?? `${question.question}-${index}`}>
            {question.header ? (
              <div className="mb-1 text-xs font-semibold uppercase tracking-caps text-fg-3">
                {question.header}
              </div>
            ) : null}
            <p className="text-base leading-6 text-fg-1">{question.question}</p>
            {question.options && question.options.length > 0 ? (
              <div className="mt-3 grid gap-2">
                {question.options.map((option, optionIndex) => (
                  <div
                    key={`${option.label}-${optionIndex}`}
                    className="rounded-3 border border-border-2 bg-surface-panel px-4 py-3"
                  >
                    <div className="text-sm font-medium text-fg-1">
                      {option.label}
                    </div>
                    {option.description ? (
                      <div className="mt-0.5 text-xs leading-5 text-fg-2">
                        {option.description}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        <p className="text-xs text-fg-3">Reply in the composer below.</p>
      </div>
    </section>
  );
}
