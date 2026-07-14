import type { AgentQuestion } from '@shared/harness';
import { Card } from '@renderer/components/ui';

export function QuestionCard({
  questions,
}: {
  questions: AgentQuestion[];
}): React.JSX.Element {
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
              <div className="flex flex-wrap gap-2">
                {question.options.map((option) => (
                  <span
                    key={option.label}
                    className="rounded-2 border border-border-1 px-2 py-1 text-xs"
                  >
                    {option.label}
                    {option.description ? ` - ${option.description}` : ''}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </Card>
  );
}
