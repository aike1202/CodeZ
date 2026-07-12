export interface PromptPredictionContextMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface PromptPredictionRequest {
  providerId: string
  model: string
  context: PromptPredictionContextMessage[]
  draft: string
}

export interface PromptPredictionResponse {
  suggestion: string
}
