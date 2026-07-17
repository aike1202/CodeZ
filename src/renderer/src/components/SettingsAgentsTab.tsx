import React, { useEffect, useState } from 'react'
import type { SubAgentInfo } from '../shared/desktop/generated/contracts'
import { desktopApi } from '../shared/desktop/api'
import Flex from './ui/Flex'
import Button from './ui/Button'
import { IconRefreshCw, IconZap, IconPackage } from './Icons'
import SubAgentDetailModal from './SubAgentDetailModal'
import './SettingsAgentsTab.css'

export default function SettingsAgentsTab(): React.ReactElement {
  const [agents, setAgents] = useState<SubAgentInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [detailType, setDetailType] = useState<string | null>(null)

  const loadAgents = async () => {
    setLoading(true)
    try {
      const data = await desktopApi.subAgent.list()
      setAgents(data)
    } catch (e) {
      console.error('Failed to load subagents', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAgents()
  }, [])

  const handleToggle = async (type: string, enabled: boolean) => {
    setAgents((prev) => prev.map((a) => (a.type === type ? { ...a, enabled } : a)))
    try {
      await desktopApi.subAgent.toggle(type, enabled)
    } catch (e) {
      console.error('Failed to toggle subagent', e)
      setAgents((prev) => prev.map((a) => (a.type === type ? { ...a, enabled: !enabled } : a)))
    }
  }

  return (
    <div className="agents-tab-container">
      {/* Header */}
      <Flex justify="between" align="start" className="mb-6">
        <div>
          <h1 className="agents-title">智能体</h1>
          <p className="agents-subtitle">
            管理内置子智能体及其候选模型。未配置模型时跟随主 Agent。
          </p>
        </div>
        <Button variant="ghost" size="none" onClick={loadAgents} title="刷新">
          <IconRefreshCw className={`w-[18px] h-[18px] ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </Flex>

      {/* List Header */}
      <div className="agents-list-title">
        可用子智能体 <span className="agents-list-count">{agents.length}</span>
      </div>

      {/* List Container */}
      <div className="agents-list-container">
        {loading ? (
          <div className="agents-list-empty">
            <IconRefreshCw className="w-6 h-6 animate-spin" />
            正在加载...
          </div>
        ) : agents.length === 0 ? (
          <div className="agents-list-empty">
            <IconPackage className="w-8 h-8" />
            没有可用的子智能体
          </div>
        ) : (
          <div className="agents-list-items">
            {agents.map((agent) => (
              <div
                key={agent.type}
                className="agents-list-item"
                onClick={() => setDetailType(agent.type)}
                role="button"
                tabIndex={0}
              >
                <div className="agents-item-icon-wrapper">
                  <IconZap className="w-5 h-5" />
                </div>

                <div className="agents-item-content">
                  <div className="agents-item-name">{agent.type}</div>
                  <p className="agents-item-desc">{agent.description || '无描述信息'}</p>
                  <span className="agents-item-model">
                    {agent.configuredModels?.length
                      ? `${agent.configuredModels.length} 个候选模型`
                      : '跟随主模型'}
                  </span>
                </div>

                <div className="agents-item-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="agents-detail-btn"
                    onClick={() => setDetailType(agent.type)}
                  >
                    查看详情
                  </button>
                  <label className="agents-switch-label">
                    <input
                      type="checkbox"
                      className="agents-switch-input"
                      checked={agent.enabled}
                      onChange={(e) => handleToggle(agent.type, e.target.checked)}
                    />
                    <div className="agents-switch-inner"></div>
                  </label>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {detailType && (
        <SubAgentDetailModal type={detailType} onClose={() => setDetailType(null)} />
      )}
    </div>
  )
}
