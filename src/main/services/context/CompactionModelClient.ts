import type {
  CompactionSummaryV1,
  NormalizedModelMessage,
  VersionedResumeState
} from '../../../shared/types/context'
import type { ApiFormat, ThinkingConfig } from '../../../shared/types/provider'
import { ChatService } from '../ChatService'
import { buildCompactionPrompt } from './CompactionSummary'

export interface CompactionModelInput {
  coveredThroughSequence: number
  messages: NormalizedModelMessage[]
  previousSummary?: CompactionSummaryV1
  resumeState?: VersionedResumeState
  instructions?: string
}

export interface CompactionModelClient {
  generate(input: CompactionModelInput): Promise<string>
}

export interface ChatCompactionModelConfig {
  baseUrl: string
  apiKey: string
  apiFormat?: ApiFormat
  model: string
  thinking?: ThinkingConfig
}

export class ChatCompactionModelClient implements CompactionModelClient {
  constructor(
    private readonly config: ChatCompactionModelConfig,
    private readonly chat = new ChatService()
  ) {}

  async generate(input: CompactionModelInput): Promise<string> {
    const prompt = buildCompactionPrompt(input)
    return new Promise<string>((resolve, reject) => {
      this.chat.streamChat({
        ...this.config,
        messages: [
          { role: 'system', content: 'You produce strict, evidence-based JSON summaries for durable context compaction.' },
          { role: 'user', content: prompt }
        ],
        tools: undefined
      }, {
        onChunk: () => undefined,
        onDone: (content) => resolve(content),
        onError: (error) => reject(new Error(error))
      }).catch(reject)
    })
  }
}
