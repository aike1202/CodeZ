import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'

import { getProviderService } from './provider.handlers'
import { getWorkspaceService } from './workspace.handlers'
import { MAIN_CONTEXT_SCOPE, type StreamRequestV2 } from '../../shared/types/context'
import { mergeModelThinkingConfig } from '../../shared/utils/reasoningCapabilities'
import type {
  ApiFormat,
  ModelContextCapabilities,
  ThinkingConfig
} from '../../shared/types/provider'
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
  readContextFeatureFlags,
  resolveModelContextCapabilities
} from '../services/context'

import type { AgentRunner } from '../agent/AgentRunner'
import { ChatRuntimeRegistry } from '../services/ChatRuntimeRegistry'
import { getAttachmentService } from './attachment.handlers'
import { getProviderImagePolicy, supportsImageInput } from '../../shared/utils/imageCapabilities'
import { SubAgentManager } from '../agent/SubAgentManager'
import { getExecutionController } from '../services/execution/ExecutionController'
import { PromptPredictionService } from '../services/PromptPredictionService'
import type {
  PromptPredictionRequest,
  PromptPredictionResponse
} from '../../shared/types/promptPrediction'
import type { ChatSteerInput, ChatSteerResult } from '../../shared/types/queuedPrompt'
import {
  buildThinkingPayload,
  resolveEffectiveReasoningBudgetTokens
} from '../services/chat/utils'
import { ToolManager } from '../tools/ToolManager'
import { getMcpConnectionManager } from '../services/mcp'
import { getWorkspacePermissionStore } from '../services/permission/workspacePermissionStore'

function applyRequestReasoningReserve(
  capabilities: ModelContextCapabilities,
  input: {
    apiFormat?: ApiFormat
    baseUrl: string
    model: string
    thinking: ThinkingConfig
  }
): ModelContextCapabilities {
  if (input.apiFormat !== 'anthropic' || !input.thinking.enabled) return capabilities
  const payload = buildThinkingPayload(
    input.thinking,
    input.model,
    input.baseUrl,
    true,
    'anthropic'
  ) as { thinking?: { budget_tokens?: number } }
  return payload.thinking?.budget_tokens
    ? { ...capabilities, reasoningCountsAgainstContext: true }
    : capabilities
}

const activeRunners = new ChatRuntimeRegistry<AgentRunner>()
const stoppedBeforeRegistration = new Set<string>()
interface ActivePromptPrediction {
  key: string
  controller: AbortController
  promise: Promise<PromptPredictionResponse>
}

const activePromptPredictions = new Map<number, ActivePromptPrediction>()
const recentPromptPredictions = new Map<number, {
  key: string
  response: PromptPredictionResponse
}>()

function buildRuntimeStatus(sessionId: string) {
  return activeRunners.getStatus(sessionId, SubAgentManager.listActiveForSession(sessionId))
}

function publishRuntimeStatus(sessionId: string): void {
  const payload = {
    version: activeRunners.getVersion(sessionId),
    status: buildRuntimeStatus(sessionId)
  }
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(IPC_CHANNELS.CHAT_RUNTIME_STATUS_CHANGED, payload)
  })
}

activeRunners.onChange(publishRuntimeStatus)
SubAgentManager.onActiveChange((sessionId) => activeRunners.touch(sessionId))
getExecutionController().onEvent((event) => {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(IPC_CHANNELS.EXECUTION_EVENT, event)
  })
})

function finishStream(streamId: string): void {
  activeRunners.unregister(streamId)
  stoppedBeforeRegistration.delete(streamId)
}

function consumePendingStop(streamId: string): boolean {
  return stoppedBeforeRegistration.delete(streamId)
}

function rememberPendingStop(streamId: string): void {
  stoppedBeforeRegistration.add(streamId)
  const timer = setTimeout(() => stoppedBeforeRegistration.delete(streamId), 60_000)
  timer.unref()
}

export function registerChatIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.CHAT_PREDICT_NEXT_INPUT,
    async (event, request: PromptPredictionRequest): Promise<PromptPredictionResponse> => {
      const empty = { suggestion: '' }
      if (
        !request?.providerId
        || !request.model
        || typeof request.draft !== 'string'
        || !Array.isArray(request.context)
      ) return empty

      const requestKey = JSON.stringify(request)
      if (requestKey.length > 100_000) return empty

      const senderId = event.sender.id
      const recent = recentPromptPredictions.get(senderId)
      if (recent?.key === requestKey) return recent.response

      const active = activePromptPredictions.get(senderId)
      if (active?.key === requestKey) return active.promise

      const providerService = getProviderService()
      const provider = providerService.getConfig(request.providerId)
      const apiKey = providerService.getApiKey(request.providerId)
      if (!provider || !apiKey) return empty

      const modelConfig = provider.models.find(
        (model) => model.id === request.model || model.name === request.model
      )
      if (!modelConfig) return empty

      active?.controller.abort()
      const controller = new AbortController()
      const predictionPromise = (async (): Promise<PromptPredictionResponse> => {
        try {
          const service = new PromptPredictionService({
            baseUrl: provider.baseUrl,
            apiKey,
            apiFormat: modelConfig.apiFormat || provider.apiFormat,
            model: modelConfig.name
          })
          const suggestion = await service.predict(request, controller.signal)
          const response = { suggestion }
          recentPromptPredictions.set(senderId, { key: requestKey, response })
          return response
        } catch (error) {
          if (!controller.signal.aborted) {
            log.warn('[Chat] next input prediction failed', {
              providerId: request.providerId,
              model: request.model,
              error: error instanceof Error ? error.message : String(error)
            })
          }
          return empty
        } finally {
          if (activePromptPredictions.get(senderId)?.controller === controller) {
            activePromptPredictions.delete(senderId)
          }
        }
      })()

      activePromptPredictions.set(senderId, {
        key: requestKey,
        controller,
        promise: predictionPromise
      })
      return predictionPromise
    }
  )

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

      const hasText = Boolean(request.input?.text?.trim())
      const hasImages = Boolean(request.input?.attachments?.length)
      if (!request.sessionId || (!hasText && !hasImages)) {
        throw new Error('会话 ID 和本次输入不能为空')
      }
      const contextFlags = readContextFeatureFlags()
      if (!contextFlags.authoritativeLedger) {
        throw new Error('规范化模型账本已通过环境变量禁用；V2 请求不会回退到 Renderer 历史。')
      }

      const providerSvc = getProviderService()
      const config = providerSvc.getConfig(request.providerId)
      if (!config) {
        log.warn('[Chat] reject: provider not found', { streamId, providerId: request.providerId })
        throw new Error('Provider 不存在')
      }

      const apiKey = providerSvc.getApiKey(request.providerId)
      if (!apiKey) {
        log.warn('[Chat] reject: no api key', { streamId, providerId: request.providerId })
        throw new Error('无法获取 API Key')
      }

      const workspaceSvc = getWorkspaceService()
      const currentWorkspace = workspaceSvc ? workspaceSvc.getCurrentWorkspace() : null
      if (!currentWorkspace) {
        log.warn('[Chat] reject: no workspace', { streamId })
        throw new Error('当前未打开任何工作区，无法启动 Agent')
      }

      const modelConfig = config.models?.find(m => m.id === request.model || m.name === request.model)
      if (hasImages && !supportsImageInput(modelConfig)) {
        throw new Error('当前模型未启用图片输入')
      }
      const apiFormat = modelConfig?.apiFormat || config.apiFormat
      const thinking = mergeModelThinkingConfig(config.thinking, modelConfig)
      const contextCapabilities = applyRequestReasoningReserve(
        resolveModelContextCapabilities(modelConfig),
        { apiFormat, baseUrl: config.baseUrl, model: request.model, thinking }
      )
      const reasoningBudgetTokens = thinking.enabled
        ? resolveEffectiveReasoningBudgetTokens(thinking, request.model, config.baseUrl, apiFormat)
        : 0
      const { contextWindowTokens } = contextCapabilities
      const { AgentRunner } = await import('../agent/AgentRunner')
      await getMcpConnectionManager().syncWorkspace(currentWorkspace)
      const toolManager = new ToolManager()
      const toolSchemas = toolManager.getToolDefinitions()
      const runner = new AgentRunner({ toolManager })
      if (consumePendingStop(streamId)) return streamId

      const { SystemPromptService } = await import('../services/SystemPromptService')
      const permissionMode = await getWorkspacePermissionStore().getMode(currentWorkspace)

      const sysPrompt = await SystemPromptService.buildSystemPrompt({
        workspaceRoot: currentWorkspace,
        modelId: request.model,
        modelDisplayName: `${modelConfig?.name || request.model} (${contextWindowTokens.toLocaleString()} context)`,
        contextWindowTokens,
        sessionId: request.sessionId,
        apiFormat,
        permissionMode,
        thinkingEnabled: thinking.enabled
      })

      const reminder = await SystemPromptService.buildSystemReminder(currentWorkspace)

      const sessionStore = await getSessionStoreReady()
      const core = getContextCoreServices()
      const compactionModel = new ChatCompactionModelClient({
        baseUrl: config.baseUrl,
        apiKey,
        apiFormat,
        model: request.model,
        thinking,
        maxOutputTokens: contextCapabilities.maxOutputTokens
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
      const downshift = await evaluateModelDownshiftCompaction({
        previousProviderId: mainScope?.lastProviderId,
        nextProviderId: request.providerId,
        previousModel: mainScope?.lastModel,
        nextModel: request.model,
        scope: mainScope,
        capabilities: contextCapabilities,
        systemPrompt: sysPrompt,
        toolSchemas,
        instructions: reminder ? [reminder] : [],
        providerRequestProfile: {
          providerId: request.providerId,
          model: request.model,
          apiFormat,
          baseUrl: config.baseUrl,
          thinking,
          maxOutputTokens: contextCapabilities.maxOutputTokens
        },
        workspaceRoot: currentWorkspace,
        reasoningBudgetTokens
      })
      if (downshift.required) {
        if (!compactionService) {
          throw new Error('新模型的输入预算不足，且正式压缩已通过环境变量禁用。')
        }
        const result = await compactionService.compact({
          sessionId: request.sessionId,
          contextScopeId: MAIN_CONTEXT_SCOPE,
          trigger: 'model_downshift',
          capabilities: contextCapabilities,
          systemPrompt: sysPrompt,
          toolSchemas,
          instructions: reminder ? [reminder] : [],
          workspaceRoot: currentWorkspace,
          reasoningBudgetTokens
        })
        if (result.status !== 'completed') {
          throw new Error(`切换到 ${request.model} 前无法将历史压缩到新模型预算内：${result.message || result.errorCode}`)
        }
      }

      const runtimeTurn = await core.coordinator.beginTurn({
        sessionId: request.sessionId,
        contextScopeId: MAIN_CONTEXT_SCOPE,
        text: request.input.text,
        providerId: request.providerId,
        model: request.model,
        commandMetadata: request.input.commandMetadata,
        attachments: request.input.attachments
      })

      if (consumePendingStop(streamId)) {
        await core.coordinator.interruptTurn(runtimeTurn, 'User aborted before runner registration')
        return streamId
      }

      // 异步执行 Agent 循环，通过 webContents.send 推送
      log.info('[Chat] runner start', { streamId, model: request.model, contextWindowTokens })
      activeRunners.register(streamId, request.sessionId, runner)

      runner.run(
        {
          baseUrl: config.baseUrl,
          apiFormat,
          apiKey,
          model: request.model,
          workspaceRoot: currentWorkspace,
          thinking,
          sessionId: request.sessionId,
          providerId: request.providerId,
          runtimeTurn,
          runtimeCoordinator: core.coordinator,
          contextBuilder,
          compactionService,
          contextCapabilities,
          systemPrompt: sysPrompt,
          tools: toolSchemas,
          contextInstructions: reminder ? [reminder] : [],
          prepareImages: (attachments) => getAttachmentService().prepareSessionImages(
            request.sessionId,
            attachments,
            getProviderImagePolicy(apiFormat)
          )
        },
        {
          onChunk: (delta, reasoningDelta) => {
            sender.send(IPC_CHANNELS.CHAT_STREAM_CHUNK, streamId, delta, reasoningDelta)
          },
          onSteerConsumed: (input) => {
            sender.send(IPC_CHANNELS.CHAT_STREAM_STEER_CONSUMED, streamId, input)
          },
          onDone: (fullContent, stopReason, txId) => {
            log.info('[Chat] done', { streamId, stopReason, contentLen: fullContent?.length ?? 0 })
            sender.send(IPC_CHANNELS.CHAT_STREAM_END, streamId, fullContent, stopReason, txId)
            finishStream(streamId)
          },
          onError: (error) => {
            log.error('[Chat] error', { streamId, error })
            sender.send(IPC_CHANNELS.CHAT_STREAM_ERROR, streamId, error)
            finishStream(streamId)
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
        finishStream(streamId)
      })

      return streamId
    }
  )

  ipcMain.handle(IPC_CHANNELS.CHAT_RUNTIME_STATUS, (_event, sessionId: string) => {
    return buildRuntimeStatus(sessionId)
  })

  ipcMain.handle(
    IPC_CHANNELS.CHAT_STREAM_STEER,
    (_event, sessionId: string, input: ChatSteerInput): ChatSteerResult => {
      if (!sessionId || !input?.queueId || (!input.text?.trim() && !input.attachments?.length)) {
        return { accepted: false, reason: 'INVALID_INPUT' }
      }
      const runner = activeRunners.getRunnerForSession(sessionId)
      if (!runner) return { accepted: false, reason: 'NO_ACTIVE_RUNNER' }
      return runner.steer(input)
        ? { accepted: true }
        : { accepted: false, reason: 'RUNNER_FINISHING' }
    }
  )

  ipcMain.handle(IPC_CHANNELS.CHAT_STREAM_STOP, (_event, streamId: string) => {
    const runner = activeRunners.getRunner(streamId)
    if (runner) {
      runner.abort()
      finishStream(streamId)
    } else {
      rememberPendingStop(streamId)
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
      const apiFormat = modelConfig?.apiFormat || provider.apiFormat
      const thinking = mergeModelThinkingConfig(provider.thinking, modelConfig)
      const contextCapabilities = applyRequestReasoningReserve(
        resolveModelContextCapabilities(modelConfig),
        { apiFormat, baseUrl: provider.baseUrl, model: scope.lastModel, thinking }
      )
      const reasoningBudgetTokens = thinking.enabled
        ? resolveEffectiveReasoningBudgetTokens(thinking, scope.lastModel, provider.baseUrl, apiFormat)
        : 0
      const { contextWindowTokens } = contextCapabilities
      const systemPrompt = await SystemPromptService.buildSystemPrompt({
        workspaceRoot: workspace,
        modelId: scope.lastModel,
        modelDisplayName: `${modelConfig?.name || scope.lastModel} (${contextWindowTokens.toLocaleString()} context)`,
        contextWindowTokens,
        sessionId: request.sessionId,
        apiFormat,
        permissionMode: await getWorkspacePermissionStore().getMode(workspace),
        thinkingEnabled: thinking.enabled
      })
      const reminder = await SystemPromptService.buildSystemReminder(workspace)
      await getMcpConnectionManager().syncWorkspace(workspace)
      const toolSchemas = new ToolManager().getToolDefinitions()
      const modelClient = new ChatCompactionModelClient({
        baseUrl: provider.baseUrl,
        apiKey,
        apiFormat,
        model: scope.lastModel,
        thinking,
        maxOutputTokens: contextCapabilities.maxOutputTokens
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
        capabilities: contextCapabilities,
        systemPrompt,
        toolSchemas,
        instructions: reminder ? [reminder] : [],
        manualInstructions: request.instructions,
        workspaceRoot: workspace,
        reasoningBudgetTokens
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

  ipcMain.handle(IPC_CHANNELS.CHAT_REVERT_MESSAGES, async (
    _event,
    sessionId: string,
    targetUiMessageId: string,
    txIds: string[]
  ) => {
    const { getEditTransactionService } = await import('../services/EditTransactionService')
    const svc = getEditTransactionService()
    const core = getContextCoreServices()
    const status = buildRuntimeStatus(sessionId)
    if (status.mainRunnerActive || status.activeSubAgentIds.length > 0) {
      throw Object.assign(new Error('Cannot revert conversation history while a run is active.'), {
        code: 'RUN_ACTIVE'
      })
    }
    return core.coordinator.runIdleScopeMaintenance(
      sessionId,
      MAIN_CONTEXT_SCOPE,
      async () => {
        return core.ledger.runScopeExclusive(
          sessionId,
          MAIN_CONTEXT_SCOPE,
          async () => {
            const storedSession = (await getSessionStoreReady()).get(sessionId)
            if (!storedSession) throw new Error(`Session not found: ${sessionId}`)
            if (!storedSession.runtime) {
              if (txIds.length > 0) await svc.revertTransactions(sessionId, txIds)
              return { legacySession: true }
            }
            const plan = await core.ledger.planHistoryRevert(
              sessionId,
              MAIN_CONTEXT_SCOPE,
              targetUiMessageId
            )
            if (txIds.length > 0) await svc.revertTransactions(sessionId, txIds)
            const committed = await core.ledger.appendIfHistoryVersion(
              sessionId,
              MAIN_CONTEXT_SCOPE,
              plan.expectedHistoryVersion,
              'history_reverted',
              plan.payload
            )
            if (!committed) {
              throw Object.assign(new Error('Conversation history changed during revert.'), {
                code: 'HISTORY_REVERT_STALE'
              })
            }
            return { historyVersion: committed.historyVersion }
          }
        )
      }
    )
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_PREVIEW_REVERT_MESSAGES, async (
    _event,
    sessionId: string,
    targetUiMessageId: string,
    txIds: string[]
  ) => {
    const { getEditTransactionService } = await import('../services/EditTransactionService')
    const svc = getEditTransactionService()
    const status = buildRuntimeStatus(sessionId)
    if (status.mainRunnerActive || status.activeSubAgentIds.length > 0) {
      throw Object.assign(new Error('Cannot preview history revert while a run is active.'), {
        code: 'RUN_ACTIVE'
      })
    }
    const storedSession = (await getSessionStoreReady()).get(sessionId)
    if (!storedSession) throw new Error(`Session not found: ${sessionId}`)
    if (storedSession.runtime) {
      await getContextCoreServices().ledger.planHistoryRevert(
        sessionId,
        MAIN_CONTEXT_SCOPE,
        targetUiMessageId
      )
    }
    return txIds.length > 0
      ? svc.previewRevertTransactions(sessionId, txIds)
      : { toDelete: [], toRestore: [] }
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
