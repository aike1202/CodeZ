import type {
  CompactionSummary,
  NormalizedModelMessage,
  VersionedResumeState
} from '../../../shared/types/context'
import type {
  AgentStopReason,
  ApiFormat,
  ChatProviderErrorCode,
  ProviderTokenUsage,
  ThinkingConfig
} from '../../../shared/types/provider'
import { ChatService } from '../ChatService'
import { buildCompactionPrompt } from './CompactionSummary'

export interface CompactionModelInput {
  coveredThroughSequence: number
  messages: NormalizedModelMessage[]
  previousSummary?: CompactionSummary
  resumeState?: VersionedResumeState
  instructions?: string
  validationFeedback?: string
}

export interface CompactionModelClient {
  generate(input: CompactionModelInput): Promise<string | CompactionGenerationResult>
}

export interface CompactionGenerationResult {
  text: string
  stopReason?: AgentStopReason
  usage?: ProviderTokenUsage
}

export class CompactionModelError extends Error {
  constructor(message: string, readonly providerCode?: ChatProviderErrorCode) {
    super(message)
    this.name = 'CompactionModelError'
  }
}

export interface ChatCompactionModelConfig {
  baseUrl: string
  apiKey: string
  apiFormat?: ApiFormat
  model: string
  thinking?: ThinkingConfig
  maxOutputTokens?: number
}

export class ChatCompactionModelClient implements CompactionModelClient {
  constructor(
    private readonly config: ChatCompactionModelConfig,
    private readonly chat = new ChatService()
  ) {}

  async generate(input: CompactionModelInput): Promise<CompactionGenerationResult> {
    const prompt = buildCompactionPrompt(input)
    return new Promise<CompactionGenerationResult>((resolve, reject) => {
      let usage: ProviderTokenUsage | undefined
      this.chat.streamChat({
        ...this.config,
        thinking: this.config.thinking
          ? { ...this.config.thinking, enabled: false, effort: 'none' }
          : { enabled: false, mode: 'none', effort: 'none' },
        maxOutputTokens: Math.min(this.config.maxOutputTokens ?? 20_000, 20_000),
        messages: [
          { role: 'system', content: 'Summarize the conversation as evidence-based continuation text. Never call tools.' },
          { role: 'user', content: prompt }
        ],
        tools: undefined
      }, {
        onChunk: () => undefined,
        onDone: (content, stopReason) => resolve({ text: content, stopReason, usage }),
        onError: (error, code) => reject(new CompactionModelError(error, code)),
        onUsage: (nextUsage) => { usage = nextUsage }
      }).catch(reject)
    })
  }
}
