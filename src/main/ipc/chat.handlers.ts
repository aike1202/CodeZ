import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'

import { getProviderService } from './provider.handlers'
import { getWorkspaceService } from './workspace.handlers'
import { MAIN_CONTEXT_SCOPE, type StreamRequestV2 } from '../../shared/types/context'
import { mergeModelThinkingConfig } from '../../shared/utils/reasoningCapabilities'
import log from '../logger'
import { getSessionStoreReady } from './session.handlers'
import {
  ChatCompactionModelClient,
  CompactionService,
  LegacySessionMigrationService,
  ModelContextBuilder,
  getContextCoreServices,
  parseAndValidateSummary,
  evaluateModelDownshiftCompaction,
  readContextFeatureFlags
} from '../services/context'

import type { AgentRunner } from '../agent/AgentRunner'
const activeRunners = new Map<string, AgentRunner>()

export function registerChatIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.CHAT_STREAM_START,
    async (event, request: StreamRequestV2): Promise<string> => {
      const streamId = request.streamId || `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      const sender = event.sender
      const win = BrowserWindow.fromWebContents(sender)
      if (!win) {
        throw new Error('无法获取窗口引用')
      }

      log.info('[Chat] stream start', { streamId, providerId: request.providerId, model: request.model, sessionId: request.sessionId })

      if (!request.sessionId || !request.input?.text?.trim()) {
        sender.send(IPC_CHANNELS.CHAT_STREAM_ERROR, streamId, '会话 ID 和本次输入不能为空')
        return streamId
      }
      const contextFlags = readContextFeatureFlags()
      if (!contextFlags.authoritativeLedger) {
        sender.send(
          IPC_CHANNELS.CHAT_STREAM_ERROR,
          streamId,
          '规范化模型账本已通过环境变量禁用；V2 请求不会回退到 Renderer 历史。'
        )
        return streamId
      }

      const providerSvc = getProviderService()
      const config = providerSvc.getConfig(request.providerId)
      if (!config) {
        log.warn('[Chat] reject: provider not found', { streamId, providerId: request.providerId })
        sender.send(IPC_CHANNELS.CHAT_STREAM_ERROR, streamId, 'Provider 不存在')
        return streamId
      }

      const apiKey = providerSvc.getApiKey(request.providerId)
      if (!apiKey) {
        log.warn('[Chat] reject: no api key', { streamId, providerId: request.providerId })
        sender.send(IPC_CHANNELS.CHAT_STREAM_ERROR, streamId, '无法获取 API Key')
        return streamId
      }

      const workspaceSvc = getWorkspaceService()
      const currentWorkspace = workspaceSvc ? workspaceSvc.getCurrentWorkspace() : null
      if (!currentWorkspace) {
        log.warn('[Chat] reject: no workspace', { streamId })
        sender.send(IPC_CHANNELS.CHAT_STREAM_ERROR, streamId, '当前未打开任何工作区，无法启动 Agent')
        return streamId
      }

      const modelConfig = config.models?.find(m => m.id === request.model || m.name === request.model)
      const contextWindowTokens = modelConfig?.maxContextTokens || 32000
      const contextCapabilities = {
        contextWindowTokens,
        maxInputTokens: modelConfig?.maxInputTokens,
        maxOutputTokens: modelConfig?.maxOutputTokens,
        reasoningCountsAgainstContext: modelConfig?.reasoningCountsAgainstContext
      }
      const { AgentRunner } = await import('../agent/AgentRunner')
      const runner = new AgentRunner()

      const { SystemPromptService } = await import('../services/SystemPromptService')

      const sysPrompt = await SystemPromptService.buildSystemPrompt({
        workspaceRoot: currentWorkspace,
        modelId: request.model,
        modelDisplayName: `${modelConfig?.name || request.model} (${contextWindowTokens.toLocaleString()} context)`,
        contextWindowTokens,
        sessionId: request.sessionId
      })

      const reminder = await SystemPromptService.buildSystemReminder(currentWorkspace)

      const sessionStore = await getSessionStoreReady()
      const core = getContextCoreServices()
      const compactionModel = new ChatCompactionModelClient({
        baseUrl: config.baseUrl,
        apiKey,
        apiFormat: modelConfig?.apiFormat || config.apiFormat,
        model: request.model,
        thinking: mergeModelThinkingConfig(config.thinking, modelConfig)
      })
      const migration = new LegacySessionMigrationService(sessionStore, core.ledger, {
        summarize: async ({ transcript }) => {
          const raw = await compactionModel.generate({
            coveredThroughSequence: 0,
            messages: [{
              id: 'legacy-transcript', turnId: 'legacy-import', role: 'user',
              content: transcript, status: 'complete', createdAt: new Date().toISOString(), sourceSequence: 0
            }]
          })
          return parseAndValidateSummary(raw, 0)
        }
      })
      const commandMetadata = request.input.commandMetadata as { uiMessageId?: string } | undefined
      await migration.ensureMigrated(request.sessionId, { excludeMessageId: commandMetadata?.uiMessageId })
      const compactionObserver = {
        onStarted: (payload: unknown) => sender.send(IPC_CHANNELS.CHAT_COMPACTION_STARTED, streamId, request.sessionId, payload),
        onCompleted: (payload: unknown) => sender.send(IPC_CHANNELS.CHAT_COMPACTION_COMPLETED, streamId, request.sessionId, payload),
        onFailed: (payload: unknown) => sender.send(IPC_CHANNELS.CHAT_COMPACTION_FAILED, streamId, request.sessionId, payload)
      }
      const compactionService = contextFlags.compaction
        ? new CompactionService(core.ledger, compactionModel, undefined, compactionObserver)
        : undefined
      const contextBuilder = new ModelContextBuilder(core.ledger, undefined, undefined, undefined, compactionService)

      const migratedState = await core.ledger.load(request.sessionId)
      const mainScope = migratedState.scopes[MAIN_CONTEXT_SCOPE]
      const downshift = evaluateModelDownshiftCompaction({
        previousModel: mainScope?.lastModel,
        nextModel: request.model,
        scope: mainScope,
        capabilities: contextCapabilities,
        systemPrompt: sysPrompt
      })
      if (downshift.required) {
          if (!compactionService) {
            sender.send(
              IPC_CHANNELS.CHAT_STREAM_ERROR,
              streamId,
              '新模型的输入预算不足，且正式压缩已通过环境变量禁用。'
            )
            return streamId
          }
          const result = await compactionService.compact({
            sessionId: request.sessionId,
            contextScopeId: MAIN_CONTEXT_SCOPE,
            trigger: 'model_downshift',
            capabilities: contextCapabilities,
            systemPrompt: sysPrompt
          })
          if (result.status !== 'completed') {
            sender.send(
              IPC_CHANNELS.CHAT_STREAM_ERROR,
              streamId,
              `切换到 ${request.model} 前无法将历史压缩到新模型预算内：${result.message || result.errorCode}`
            )
            return streamId
          }
      }

      const runtimeTurn = await core.coordinator.beginTurn({
        sessionId: request.sessionId,
        contextScopeId: MAIN_CONTEXT_SCOPE,
        text: request.input.text,
        providerId: request.providerId,
        model: request.model,
        commandMetadata: request.input.commandMetadata
      })

      // 异步执行 Agent 循环，通过 webContents.send 推送
      log.info('[Chat] runner start', { streamId, model: request.model, contextWindowTokens })
      activeRunners.set(streamId, runner)

      runner.run(
        {
          baseUrl: config.baseUrl,
          apiFormat: modelConfig?.apiFormat || config.apiFormat,
          apiKey,
          model: request.model,
          workspaceRoot: currentWorkspace,
          thinking: mergeModelThinkingConfig(config.thinking, modelConfig),
          sessionId: request.sessionId,
          providerId: request.providerId,
          runtimeTurn,
          runtimeCoordinator: core.coordinator,
          contextBuilder,
          compactionService,
          contextCapabilities,
          systemPrompt: sysPrompt,
          contextInstructions: reminder ? [reminder] : []
        },
        {
          onChunk: (delta, reasoningDelta) => {
            sender.send(IPC_CHANNELS.CHAT_STREAM_CHUNK, streamId, delta, reasoningDelta)
          },
          onDone: (fullContent, stopReason, txId) => {
            log.info('[Chat] done', { streamId, stopReason, contentLen: fullContent?.length ?? 0 })
            sender.send(IPC_CHANNELS.CHAT_STREAM_END, streamId, fullContent, stopReason, txId)
            activeRunners.delete(streamId)
          },
          onError: (error) => {
            log.error('[Chat] error', { streamId, error })
            sender.send(IPC_CHANNELS.CHAT_STREAM_ERROR, streamId, error)
            activeRunners.delete(streamId)
          },
          onContextBudget: (snapshot) => {
            sender.send(IPC_CHANNELS.CHAT_CONTEXT_BUDGET_UPDATED, streamId, request.sessionId, snapshot)
          },
          onToolStart: (toolCallId, name, args, thoughtSignature, batch) => {
            log.info('[Chat] tool start', { streamId, name })
            sender.send(IPC_CHANNELS.CHAT_STREAM_TOOL_START, streamId, toolCallId, name, args, thoughtSignature, batch)
          },
          onToolEnd: (toolCallId, result) => {
            log.info('[Chat] tool end', { streamId })
            sender.send(IPC_CHANNELS.CHAT_STREAM_TOOL_END, streamId, toolCallId, result)
          },
          onSubAgentStart: (subAgentId, meta) => {
            sender.send(IPC_CHANNELS.CHAT_STREAM_SUBAGENT_START, streamId, subAgentId, meta)
          },
          onSubAgentEnd: (subAgentId, result) => {
            sender.send(IPC_CHANNELS.CHAT_STREAM_SUBAGENT_END, streamId, subAgentId, result)
          },
          onSubAgentChunk: (subAgentId, delta, reasoningDelta) => {
            sender.send(IPC_CHANNELS.CHAT_STREAM_SUBAGENT_CHUNK, streamId, subAgentId, delta, reasoningDelta)
          },
          onSubAgentToolStart: (subAgentId, toolCallId, name, args, thoughtSignature) => {
            sender.send(IPC_CHANNELS.CHAT_STREAM_SUBAGENT_TOOL_START, streamId, subAgentId, toolCallId, name, args, thoughtSignature)
          },
          onSubAgentToolEnd: (subAgentId, toolCallId, result) => {
            sender.send(IPC_CHANNELS.CHAT_STREAM_SUBAGENT_TOOL_END, streamId, subAgentId, toolCallId, result)
          },
          onPermissionRequest: async (request) => {
            return new Promise((resolve) => {
              sender.send(IPC_CHANNELS.CHAT_REQUEST_APPROVAL, streamId, request)
              const responseChannel = `${IPC_CHANNELS.CHAT_APPROVAL_RESPONSE}:${request.id}`
              let settled = false
              let timer: NodeJS.Timeout | undefined
              const finish = (response: unknown) => {
                if (settled) return
                settled = true
                if (timer) clearTimeout(timer)
                ipcMain.removeHandler(responseChannel)
                sender.removeListener('destroyed', onDestroyed)
                if (typeof response === 'boolean') return resolve(response)
                if (
                  response && typeof response === 'object' &&
                  typeof (response as any).approved === 'boolean' &&
                  ['once', 'session', 'workspace'].includes((response as any).scope)
                ) return resolve(response as any)
                resolve(false)
              }
              const onDestroyed = () => finish(false)
              timer = setTimeout(() => finish(false), 10 * 60 * 1000)
              sender.once('destroyed', onDestroyed)
              ipcMain.handleOnce(responseChannel, (_event, response: unknown) => {
                finish(response)
              })
            })
          },
          onAskUserRequest: (request) => {
            return new Promise((resolve) => {
              sender.send(IPC_CHANNELS.CHAT_REQUEST_ASK_USER, streamId, request)
              const responseChannel = `${IPC_CHANNELS.CHAT_ASK_USER_RESPONSE}:${request.id}`
              ipcMain.handleOnce(responseChannel, (_event, answers) => {
                resolve(answers || [])
              })
            })
          },
          onPlanReview: (plan) => {
            return new Promise((resolve) => {
              sender.send('plan:review-request', streamId, plan)
              planReviewResolvers.set(streamId, resolve)
            })
          }
        }
      ).catch((error) => {
        log.error('[Chat] runner crashed', { streamId, error: error instanceof Error ? error.message : String(error) })
        sender.send(IPC_CHANNELS.CHAT_STREAM_ERROR, streamId, `未知错误: ${error}`)
        activeRunners.delete(streamId)
      })

      return streamId
    }
  )

  ipcMain.handle(IPC_CHANNELS.CHAT_STREAM_STOP, (_event, streamId: string) => {
    const runner = activeRunners.get(streamId)
    if (runner) {
      runner.abort()
      activeRunners.delete(streamId)
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.CHAT_COMPACT_START,
    async (event, request: { sessionId: string; instructions?: string }) => {
      const sender = event.sender
      const streamId = `compact_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      if (!readContextFeatureFlags().compaction) {
        return { accepted: false, reason: 'FEATURE_DISABLED' }
      }
      const core = getContextCoreServices()
      if (core.coordinator.isScopeBusy(request.sessionId, MAIN_CONTEXT_SCOPE)) {
        return { accepted: false, reason: 'TURN_BUSY' }
      }
      const state = await core.ledger.load(request.sessionId)
      const scope = state.scopes[MAIN_CONTEXT_SCOPE]
      if (!scope?.lastProviderId || !scope.lastModel) {
        return { accepted: false, reason: 'NO_MODEL_CONTEXT' }
      }
      const providerSvc = getProviderService()
      const provider = providerSvc.getConfig(scope.lastProviderId)
      const apiKey = providerSvc.getApiKey(scope.lastProviderId)
      const modelConfig = provider?.models.find((model) => model.id === scope.lastModel || model.name === scope.lastModel)
      const workspace = getWorkspaceService()?.getCurrentWorkspace()
      if (!provider || !apiKey || !workspace) return { accepted: false, reason: 'PROVIDER_UNAVAILABLE' }

      const { SystemPromptService } = await import('../services/SystemPromptService')
      const contextWindowTokens = modelConfig?.maxContextTokens || 32000
      const systemPrompt = await SystemPromptService.buildSystemPrompt({
        workspaceRoot: workspace,
        modelId: scope.lastModel,
        modelDisplayName: `${modelConfig?.name || scope.lastModel} (${contextWindowTokens.toLocaleString()} context)`,
        contextWindowTokens,
        sessionId: request.sessionId
      })
      const modelClient = new ChatCompactionModelClient({
        baseUrl: provider.baseUrl,
        apiKey,
        apiFormat: modelConfig?.apiFormat || provider.apiFormat,
        model: scope.lastModel,
        thinking: mergeModelThinkingConfig(provider.thinking, modelConfig)
      })
      const service = new CompactionService(core.ledger, modelClient, undefined, {
        onStarted: (payload) => sender.send(IPC_CHANNELS.CHAT_COMPACTION_STARTED, streamId, request.sessionId, payload),
        onCompleted: (payload) => sender.send(IPC_CHANNELS.CHAT_COMPACTION_COMPLETED, streamId, request.sessionId, payload),
        onFailed: (payload) => sender.send(IPC_CHANNELS.CHAT_COMPACTION_FAILED, streamId, request.sessionId, payload)
      })
      const result = await service.compact({
        sessionId: request.sessionId,
        contextScopeId: MAIN_CONTEXT_SCOPE,
        trigger: 'manual',
        capabilities: {
          contextWindowTokens,
          maxInputTokens: modelConfig?.maxInputTokens,
          maxOutputTokens: modelConfig?.maxOutputTokens,
          reasoningCountsAgainstContext: modelConfig?.reasoningCountsAgainstContext
        },
        systemPrompt,
        manualInstructions: request.instructions
      })
      return { accepted: result.status === 'completed', result }
    }
  )

  ipcMain.handle(IPC_CHANNELS.CHAT_ACCEPT_FILE, async (_event, txId: string, filePath: string) => {
    const { getEditTransactionService } = await import('../services/EditTransactionService')
    const svc = getEditTransactionService()
    return await svc.commitFile(txId, filePath)
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_REJECT_FILE, async (_event, txId: string, filePath: string) => {
    const { getEditTransactionService } = await import('../services/EditTransactionService')
    const svc = getEditTransactionService()
    return await svc.rollbackFile(txId, filePath)
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_GET_DIFF, async (_event, txId: string) => {
    const { getEditTransactionService } = await import('../services/EditTransactionService')
    const svc = getEditTransactionService()
    return await svc.getDiff(txId)
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_REVERT_MESSAGES, async (_event, sessionId: string, txIds: string[]) => {
    const { getEditTransactionService } = await import('../services/EditTransactionService')
    const svc = getEditTransactionService()
    await svc.revertTransactions(sessionId, txIds)
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_PREVIEW_REVERT_MESSAGES, async (_event, sessionId: string, txIds: string[]) => {
    const { getEditTransactionService } = await import('../services/EditTransactionService')
    const svc = getEditTransactionService()
    return await svc.previewRevertTransactions(sessionId, txIds)
  })

  // Plan 审批 IPC（per-stream 决策）
  const planReviewResolvers = new Map<string, (decision: { approved: boolean; feedback?: string }) => void>()

  ipcMain.handle(IPC_CHANNELS.PLAN_APPROVE, (_event, streamId: string, planSlug: string) => {
    const resolver = planReviewResolvers.get(streamId)
    if (resolver) {
      resolver({ approved: true })
      planReviewResolvers.delete(streamId)
      return true
    }
    return false
  })

  ipcMain.handle(IPC_CHANNELS.PLAN_REJECT, (_event, streamId: string, planSlug: string, feedback: string) => {
    const resolver = planReviewResolvers.get(streamId)
    if (resolver) {
      resolver({ approved: false, feedback })
      planReviewResolvers.delete(streamId)
      return true
    }
    return false
  })

  // planReviewResolvers is available via the module scope for AgentRunner use
}
