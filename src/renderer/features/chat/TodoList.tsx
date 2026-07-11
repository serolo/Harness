// Renders a todo_update AgentEvent as a checklist.

import type { Todo } from '@shared/harness';

export interface TodoListProps {
  todos: Todo[];
}

export function TodoList({ todos }: TodoListProps): React.JSX.Element {
  return (
    <div
      className="my-1 rounded-3 border border-border-1 bg-surface-card p-2"
      data-testid="todo-list"
    >
      <div className="mb-1 text-xs font-medium uppercase tracking-caps text-fg-3">
        Todos
      </div>
      <ul className="space-y-0.5">
        {todos.map((todo) => (
          <li
            key={todo.id}
            className="flex items-center gap-2 text-base text-fg-1"
            data-done={todo.done}
          >
            <span aria-hidden="true">{todo.done ? '☑' : '☐'}</span>
            <span className={todo.done ? 'text-fg-3 line-through' : ''}>
              {todo.body}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
