import { Tool, ToolContext } from '../Tool'

export class RollbackLastEditTool extends Tool {
  get name() {
    return 'rollback_last_edit'
  }

  get summary() {
    return 'Rollback the most recent edit.'
  }

  get description() {
    return 'Rolls back all file modifications made in the current editing transaction. Use this when a code change caused compilation errors, test failures, or other problems and you want to undo all changes made in this round.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Optional reason for the rollback (e.g., "compilation failed", "wrong approach").'
        }
      }
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    const parsedArgs = args ? JSON.parse(args) : {}
    const reason = parsedArgs.reason || 'No reason provided'

    if (!context.editTransactionService) {
      return 'Error: Edit transaction service is not available.'
    }

    const txId = context.transactionId
    if (!txId) {
      return 'No active editing transaction to rollback.'
    }

    const tx = context.editTransactionService.getTransaction(txId)
    if (!tx) {
      return 'Active transaction not found.'
    }

    if (tx.backedUpFiles.size === 0) {
      return 'No files were modified in the current transaction. Nothing to rollback.'
    }

    try {
      const restoredFiles = await context.editTransactionService.rollback(tx.id)
      const fileList = restoredFiles.map(f => `  - ${f}`).join('\n')
      return `Successfully rolled back ${restoredFiles.length} file(s).\nReason: ${reason}\nRestored files:\n${fileList}`
    } catch (err: any) {
      return `Error during rollback: ${err.message}`
    }
  }
}
