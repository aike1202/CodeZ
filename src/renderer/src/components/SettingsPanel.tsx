import React, { useState } from 'react'
import type { ThinkingConfig, ThinkingMode, ThinkingEffort, ApiFormat } from '@shared/types/provider'
import { IconAdd, IconEye, IconEyeOff, IconTrash, IconClose } from './Icons'
import Button from './ui/Button'
import Input from './ui/Input'
import Select from './ui/Select'
import './SettingsPanel.css'

export interface ModelFormData {
  id: string
  name: string
  maxContextTokens: number
  apiFormat?: ApiFormat
  thinkingMode?: ThinkingMode
}

interface ProviderFormData {
  name: string
  baseUrl: string
  apiKey: string
  apiFormat?: ApiFormat
  models: ModelFormData[]
  thinking: ThinkingConfig
}

interface SettingsPanelProps {
  initialData: ProviderFormData
  isNew: boolean
  onSave: (data: ProviderFormData) => void
  onDelete?: () => void
  onTest?: () => void
  testResult?: { success: boolean; message: string }
}

function genModelId(): string {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

function getDefaultThinking(): ThinkingConfig {
  return { enabled: true, mode: 'openai', effort: 'auto' }
}

export default function SettingsPanel({
  initialData,
  isNew,
  onSave,
  onDelete,
  onTest,
  testResult
}: SettingsPanelProps): React.ReactElement {
  const [name, setName] = useState(initialData.name || '')
  const [baseUrl, setBaseUrl] = useState(initialData.baseUrl || '')
  const [apiFormat, setApiFormat] = useState<ApiFormat>(initialData.apiFormat || 'openai')
  const [apiKey, setApiKey] = useState(initialData.apiKey || '')
  const [thinking, setThinking] = useState<ThinkingConfig>(initialData.thinking || getDefaultThinking())
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<ModelFormData[]>(
    Array.isArray(initialData.models) && initialData.models.length > 0
      ? initialData.models
      : [{ id: genModelId(), name: '', maxContextTokens: 128000 }]
  )

  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')

  const canSave =
    (name || '').trim() !== '' &&
    (baseUrl || '').trim() !== '' &&
    models.some((m) => (m?.name || '').trim() !== '')

  const handleSave = async () => {
    setSaveStatus('saving')
    try {
      await onSave({ name, baseUrl, apiFormat, apiKey, models, thinking })
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch {
      setSaveStatus('idle')
    }
  }

  const addModel = () => {
    setModels([...models, { id: genModelId(), name: '', maxContextTokens: 128000 }])
  }

  const removeModel = (idx: number) => {
    setModels(models.filter((_, i) => i !== idx))
  }

  const updateModel = (idx: number, field: keyof ModelFormData, value: string | number | undefined) => {
    setModels(models.map((m, i) => (i === idx ? { ...m, [field]: value } : m)))
  }

  return (
    <div className="settings-panel-container">
      <div className="settings-panel-inner">
        <div className="settings-panel-header">
          <div className="settings-panel-header-title-area">
          <h2 className="settings-panel-title">{isNew ? '新建 Provider' : name}</h2>
            {!isNew && (
              <>
                <span className="settings-status-tag">已启用</span>
              </>
            )}
          </div>
          {!isNew && onDelete && (
            <Button type="text" danger size="none" className="settings-trash-btn" onClick={onDelete} title="删除该提供商">
              <IconTrash />
            </Button>
          )}
        </div>

        <div className="settings-form-container">
          {/* 名称，如果是新建则显示 */}
          {isNew && (
            <div>
              <label className="settings-label">提供商名称</label>
              <Input
                placeholder="例如: DeepSeek"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          )}

          {/* Base URL */}
          <div>
            <label className="settings-label">Base URL</label>
            <Input
              placeholder="https://api.openai.com/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>

          {/* API 格式 */}
          <div>
            <label className="settings-label">API 格式 (协议)</label>
            <Select
              value={apiFormat}
              onChange={(e) => setApiFormat(e.target.value as ApiFormat)}
            >
              <option value="openai">OpenAI Compatible (/v1/chat/completions)</option>
              <option value="anthropic">Anthropic Messages (/v1/messages)</option>
              <option value="gemini">Gemini Native (streamGenerateContent)</option>
              <option value="ollama">Ollama</option>
              <option value="azure">Azure OpenAI</option>
            </Select>
          </div>

          {/* API Key */}
          <div>
            <label className="settings-label">
              API Key
            </label>
            <div className="settings-apikey-wrapper">
              <Input
                type={showKey ? 'text' : 'password'}
                placeholder="sk-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <Button 
                type="text"
                size="none"
                className="settings-eye-btn" 
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? <IconEyeOff /> : <IconEye />}
              </Button>
            </div>
          </div>

          {/* Thinking 配置 */}
          <div>
            <label className="settings-label">思考输出</label>
            <div className="settings-thinking-box">
              <label className="settings-checkbox-label">
                <input
                  type="checkbox"
                  checked={thinking.enabled}
                  onChange={(e) => setThinking({ ...thinking, enabled: e.target.checked })}
                />
                启用模型 reasoning / thinking 输出
              </label>
              <Select
                className="settings-thinking-select"
                value={thinking.mode}
                disabled={!thinking.enabled}
                onChange={(e) => setThinking({ ...thinking, mode: e.target.value as ThinkingMode })}
              >
                <option value="auto">自动智能适配 (推荐)</option>
                <option value="openai">通用 OpenAI-compatible</option>
                <option value="deepseek">DeepSeek reasoning</option>
                <option value="qwen">Qwen enable_thinking</option>
                <option value="anthropic">Anthropic thinking summarized</option>
                <option value="gemini">Google Gemini 思考配置</option>
                <option value="openrouter">OpenRouter include_reasoning</option>
                <option value="none">不发送思考参数</option>
              </Select>
              <p className="settings-thinking-desc">
                全局思考模式。如果未在模型列表中单独覆盖，则使用此默认配置。
              </p>
            </div>
          </div>

          {/* 模型列表 */}
          <div>
            <label className="settings-label">模型列表</label>
            <div className="settings-models-box">
              {models.map((m, idx) => m ? (
                <div key={m.id || idx} className="settings-model-card">
                  <div className="settings-model-row">
                    <div className="settings-model-name-wrapper">
                      <Input
                        variant="borderless"
                        className="settings-model-input"
                        placeholder="模型名，如 gpt-4o"
                        value={m.name || ''}
                        onChange={(e) => updateModel(idx, 'name', e.target.value)}
                      />
                    </div>
                    <div className="settings-model-tokens-wrapper">
                      <Input
                        variant="borderless"
                        type="number"
                        step="0.1"
                        className="settings-tokens-input"
                        placeholder="上下文"
                        value={m.maxContextTokens ? m.maxContextTokens / 10000 : ''}
                        onChange={(e) => updateModel(idx, 'maxContextTokens', Math.round((parseFloat(e.target.value) || 0) * 10000))}
                      />
                      <span className="settings-tokens-unit">万Tokens</span>
                      <Button type="text" danger size="none" className="settings-remove-model-btn" onClick={() => removeModel(idx)}>
                        <IconClose />
                      </Button>
                    </div>
                  </div>
                  <div className="settings-model-advanced-row">
                    <Select
                      className="settings-model-advanced-select"
                      value={m.apiFormat || ''}
                      onChange={(e) => updateModel(idx, 'apiFormat', e.target.value === '' ? undefined : e.target.value)}
                    >
                      <option value="">继承全局协议格式</option>
                      <option value="openai">OpenAI 格式</option>
                      <option value="anthropic">Anthropic 格式</option>
                      <option value="gemini">Gemini 格式</option>
                    </Select>
                    <Select
                      className="settings-model-advanced-select"
                      value={m.thinkingMode || ''}
                      onChange={(e) => updateModel(idx, 'thinkingMode', e.target.value === '' ? undefined : e.target.value)}
                    >
                      <option value="">继承全局思考模式</option>
                      <option value="auto">自动适配</option>
                      <option value="openai">OpenAI 格式</option>
                      <option value="deepseek">DeepSeek 格式</option>
                      <option value="anthropic">Anthropic 格式</option>
                      <option value="qwen">Qwen 格式</option>
                    </Select>
                  </div>
                </div>
              ) : null)}
              <div className="settings-add-model-wrapper">
                <Button 
                  type="text"
                  size="none"
                  className="settings-add-model-btn" 
                  onClick={addModel}
                >
                  <IconAdd />
                  添加模型
                </Button>
              </div>
            </div>
          </div>
          
          {/* 底部操作与测试状态 */}
          <div className="settings-actions-footer">
            <div className="settings-actions-footer-inner">
              <Button
                type="primary"
                size="md"
                disabled={!canSave || saveStatus === 'saving'}
                onClick={handleSave}
              >
                {saveStatus === 'saving' ? '保存中...' : saveStatus === 'saved' ? '已保存!' : '保存配置'}
              </Button>
              
              {!isNew && (
                <>
                  <Button 
                    type="default"
                    size="md"
                    onClick={onTest}
                  >
                    测试连接
                  </Button>
                  {testResult && (
                    <span className={`settings-test-result ${testResult.success ? 'is-success' : 'is-error'}`}>
                      {testResult.message}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}