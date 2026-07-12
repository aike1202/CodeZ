import type {
  PreparedToolCall,
  ToolAfterExecuteHookContext,
  ToolBeforeExecuteHookContext,
  ToolBeforeExecuteHookResult,
  ToolExecutionResult,
  ToolRuntimeHook
} from './types'

export class ToolHookRunner {
  constructor(private readonly hooks: readonly ToolRuntimeHook[] = []) {}

  async beforeExecute(context: ToolBeforeExecuteHookContext): Promise<ToolBeforeExecuteHookResult> {
    let prepared: PreparedToolCall = context.prepared
    for (const hook of this.hooks) {
      if (!hook.beforeExecute) continue
      const result = await hook.beforeExecute({ ...context, prepared })
      if (result.action === 'deny') return result
      if (result.action === 'replace-input') {
        prepared = { ...prepared, input: result.input }
      }
    }
    return prepared === context.prepared
      ? { action: 'continue' }
      : { action: 'replace-input', input: prepared.input, reason: 'runtime-hook' }
  }

  async afterExecute(context: ToolAfterExecuteHookContext): Promise<ToolExecutionResult> {
    let result = context.result
    for (const hook of this.hooks) {
      if (!hook.afterExecute) continue
      result = await hook.afterExecute({ ...context, result }) || result
    }
    return result
  }
}

