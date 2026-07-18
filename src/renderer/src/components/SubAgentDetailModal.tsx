import React, { useEffect, useState } from 'react'
import type {
  SubAgentDetailResult,
  SubAgentModelSelection,
  SubAgentSettingsDetail
} from '../shared/desktop/generated/contracts'
import { desktopApi } from '../shared/desktop/api'
import Button from './ui/Button'
import Flex from './ui/Flex'
import Stack from './ui/Stack'
import Card from './ui/Card'
import {
  IconChevronsDown,
  IconChevronsUp,
  IconClose,
  IconTrash,
  IconZap
} from './Icons'
import { useProviderStore } from '../stores/providerStore'
import './SubAgentDetailModal.css'

interface Props {
  type: string
  onClose: () => void
}

const ISOLATION_LABELS: Record<string, string> = {
  none: '无（共享工作区）',
  worktree: '独立 worktree'
}

function detailFromBridgeResult(result: unknown): SubAgentSettingsDetail | null {
  if (!result || typeof result !== 'object') return null
  const typed = result as SubAgentDetailResult
  if (typed.kind === 'available' || typed.kind === 'partial') return typed.detail
  return null
}

export default function SubAgentDetailModal({ type, onClose }: Props): React.ReactElement {
  const [detail, setDetail] = useState<SubAgentSettingsDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [savingModel, setSavingModel] = useState(false)
  const [modelError, setModelError] = useState('')
  const providers = useProviderStore((state) => state.providers)
  const loadProviders = useProviderStore((state) => state.loadProviders)

  useEffect(() => {
    let alive = true
    setLoading(true)
    desktopApi.subAgent
      .getDetail(type)
      .then((result) => {
        if (alive) setDetail(detailFromBridgeResult(result))
      })
      .catch((e) => console.error('Failed to load subagent detail', e))
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [type])

  useEffect(() => {
    if (providers.length === 0) void loadProviders()
  }, [providers.length, loadProviders])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const saveModels = async (selections: SubAgentModelSelection[]) => {
    if (!detail) return
    setSavingModel(true)
    setModelError('')
    try {
      await desktopApi.subAgent.setModel(detail.type, selections)
      setDetail((current) => current
        ? { ...current, configuredModels: selections.length > 0 ? selections : undefined }
        : current)
    } catch (error) {
      setModelError(error instanceof Error ? error.message : '模型配置保存失败')
    } finally {
      setSavingModel(false)
    }
  }

  const handleAddModel = (value: string) => {
    if (!detail || !value) return
    const selection = JSON.parse(value) as SubAgentModelSelection
    void saveModels([...(detail.configuredModels || []), selection])
  }

  const handleRemoveModel = (index: number) => {
    if (!detail) return
    void saveModels((detail.configuredModels || []).filter((_, itemIndex) => itemIndex !== index))
  }

  const handleMoveModel = (index: number, offset: -1 | 1) => {
    if (!detail) return
    const next = [...(detail.configuredModels || [])]
    const target = index + offset
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    void saveModels(next)
  }

  const selectedModelKeys = new Set(
    (detail?.configuredModels || []).map((selection) =>
      `${selection.providerId}\u0000${selection.model}`
    )
  )

  const renderMultiline = (text?: string) =>
    text
      ? text
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      : []

  return (
    <Flex className="sad-overlay" onClick={onClose}>
      <Card
        variant="default"
        className="sad-card"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <Stack className="sad-inner">
          {/* Header */}
          <Flex align="center" justify="between" className="sad-header">
            <Flex align="center" gap={2.5} className="min-w-0">
              <span className="sad-header-icon">
                <IconZap className="w-5 h-5" />
              </span>
              <Stack className="min-w-0">
                <span className="sad-header-title">{detail?.type || type}</span>
                <span className="sad-header-sub">子智能体详情</span>
              </Stack>
            </Flex>
            <Button variant="ghost" size="none" onClick={onClose} className="sad-close-btn">
              <IconClose />
            </Button>
          </Flex>

          {/* Body */}
          <Stack className="sad-body">
            {loading ? (
              <div className="sad-empty">加载中...</div>
            ) : !detail ? (
              <div className="sad-empty">未找到该子智能体</div>
            ) : (
              <Stack gap={5}>
                {/* 状态 + 元信息 */}
                <div className="sad-meta-grid">
                  <div className="sad-meta-item">
                    <span className="sad-meta-label">状态</span>
                    <span
                      className={`sad-status ${detail.enabled ? 'is-on' : 'is-off'}`}
                    >
                      {detail.enabled ? '已启用' : '已禁用'}
                    </span>
                  </div>
                  <div className="sad-meta-item">
                    <span className="sad-meta-label">最大轮数</span>
                    <span className="sad-meta-value">{detail.maxLoops}</span>
                  </div>
                  <div className="sad-meta-item">
                    <span className="sad-meta-label">模型策略</span>
                    <span className="sad-meta-value">
                      {detail.configuredModels?.length
                        ? `${detail.configuredModels.length} 个候选模型`
                        : '跟随主 Agent'}
                    </span>
                  </div>
                  <div className="sad-meta-item">
                    <span className="sad-meta-label">隔离方式</span>
                    <span className="sad-meta-value">
                      {ISOLATION_LABELS[detail.isolation || 'none'] || detail.isolation}
                    </span>
                  </div>
                  <div className="sad-meta-item">
                    <span className="sad-meta-label">后台运行</span>
                    <span className="sad-meta-value">
                      {detail.canRunInBackground ? '支持' : '不支持'}
                    </span>
                  </div>
                </div>

                <section className="sad-section">
                  <h4 className="sad-section-title">运行模型</h4>
                  {detail.configuredModels?.length ? (
                    <div className="sad-model-priority-list">
                      {detail.configuredModels.map((selection, index) => {
                        const provider = providers.find((item) => item.id === selection.providerId)
                        return (
                          <div
                            key={`${selection.providerId}:${selection.model}`}
                            className="sad-model-priority-item"
                          >
                            <span className="sad-model-priority-index">{index + 1}</span>
                            <span className="sad-model-priority-name">
                              {provider?.name || '未知 Provider'} / {selection.model}
                            </span>
                            <div className="sad-model-priority-actions">
                              <Button
                                variant="ghost"
                                size="none"
                                title="上移"
                                disabled={savingModel || index === 0}
                                onClick={() => handleMoveModel(index, -1)}
                              >
                                <IconChevronsUp />
                              </Button>
                              <Button
                                variant="ghost"
                                size="none"
                                title="下移"
                                disabled={savingModel || index === detail.configuredModels!.length - 1}
                                onClick={() => handleMoveModel(index, 1)}
                              >
                                <IconChevronsDown />
                              </Button>
                              <Button
                                variant="ghost"
                                size="none"
                                title="移除"
                                disabled={savingModel}
                                onClick={() => handleRemoveModel(index)}
                              >
                                <IconTrash />
                              </Button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <p className="sad-text sad-muted">
                      当前使用自动策略。
                    </p>
                  )}
                  <select
                    className="sad-model-select"
                    value=""
                    disabled={savingModel}
                    onChange={(event) => handleAddModel(event.target.value)}
                  >
                    <option value="">添加候选模型...</option>
                    {providers.map((provider) => (
                      <optgroup key={provider.id} label={provider.name}>
                        {provider.models.filter((model) =>
                          !selectedModelKeys.has(`${provider.id}\u0000${model.name}`)
                        ).map((model) => {
                          const selection = JSON.stringify({
                            providerId: provider.id,
                            model: model.name
                          })
                          return (
                            <option key={model.id} value={selection}>
                              {model.name}
                            </option>
                          )
                        })}
                      </optgroup>
                    ))}
                  </select>
                  <p className="sad-text sad-muted">
                    按列表顺序使用首个可用模型；列表为空时跟随主 Agent。
                  </p>
                  {modelError && <p className="sad-model-error">{modelError}</p>}
                </section>

                {/* 描述 */}
                <section className="sad-section">
                  <h4 className="sad-section-title">描述</h4>
                  <p className="sad-text">{detail.description}</p>
                </section>

                {/* 何时使用 */}
                {renderMultiline(detail.whenToUse).length > 0 && (
                  <section className="sad-section">
                    <h4 className="sad-section-title">何时委派</h4>
                    <ul className="sad-list">
                      {renderMultiline(detail.whenToUse).map((l, i) => (
                        <li key={i}>{l}</li>
                      ))}
                    </ul>
                  </section>
                )}

                {/* 何时不使用 */}
                {renderMultiline(detail.whenNotToUse).length > 0 && (
                  <section className="sad-section">
                    <h4 className="sad-section-title">何时不委派</h4>
                    <ul className="sad-list sad-list-warn">
                      {renderMultiline(detail.whenNotToUse).map((l, i) => (
                        <li key={i}>{l}</li>
                      ))}
                    </ul>
                  </section>
                )}

                {/* 成本 */}
                {detail.costHint && (
                  <section className="sad-section">
                    <h4 className="sad-section-title">调用成本</h4>
                    <p className="sad-text">{detail.costHint}</p>
                  </section>
                )}

                {/* 结构化输出 */}
                {detail.outputSpec && (
                  <section className="sad-section">
                    <h4 className="sad-section-title">结构化输出 (submit_result)</h4>
                    <p className="sad-text sad-muted">{detail.outputSpec.description}</p>
                    <div className="sad-fields">
                      {detail.outputSpec.fields.map((f) => (
                        <div key={f.name} className="sad-field-row">
                          <div className="sad-field-head">
                            <code className="sad-field-name">{f.name}</code>
                            <span className="sad-field-type">{f.type}</span>
                            {f.required && <span className="sad-field-req">必填</span>}
                          </div>
                          <p className="sad-field-desc">{f.description}</p>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

              </Stack>
            )}
          </Stack>
        </Stack>
      </Card>
    </Flex>
  )
}
