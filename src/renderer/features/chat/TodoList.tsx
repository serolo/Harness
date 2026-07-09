// Renders a todo_update AgentEvent as a checklist.

import type { Todo } from '@shared/harness';

export interface TodoListProps {
  todos: Todo[];
}

export function TodoList({ todos }: TodoListProps): React.JSX.Element {
  return (
    <div
      className="my-1 rounded-md border border-slate-800 bg-slate-900/60 p-2"
      data-testid="todo-list"
    >
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
        Todos
      </div>
      <ul className="space-y-0.5">
        {todos.map((todo) => (
          <li
            key={todo.id}
            className="flex items-center gap-2 text-sm text-slate-200"
            data-done={todo.done}
          >
            <span aria-hidden="true">{todo.done ? '☑' : '☐'}</span>
            <span className={todo.done ? 'text-slate-500 line-through' : ''}>
              {todo.body}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
