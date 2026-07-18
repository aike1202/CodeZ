import type { TodoItem } from '../../../../shared/types/todo'

export const getTodoDisplayItems = (todos: TodoItem[]): TodoItem[] =>
  todos

export const getRemainingTodoCount = (todos: TodoItem[]): number =>
  todos.filter((todo) => todo.status === 'pending' || todo.status === 'in_progress').length
