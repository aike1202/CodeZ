import React, { useEffect, useState } from 'react'
import Flex from './ui/Flex'
import Stack from './ui/Stack'
import { IconBook, IconAdd, IconTrash, IconFolder, IconChevron, IconMessagePlus, IconMoreHorizontal, IconMessage } from './Icons'
import { useRulesStore } from '../stores/rulesStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import type { RuleFile, RuleScope } from '@shared/types/rules'
import './SettingsRulesTab.css'

export default function SettingsRulesTab(): React.ReactElement {
  const rules = useRulesStore(s => s.rules)
  const loadRules = useRulesStore(s => s.loadRules)
  const saveRule = useRulesStore(s => s.saveRule)
  const deleteRule = useRulesStore(s => s.deleteRule)
  
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  
  // Local state for the editor
  const [editingRule, setEditingRule] = useState<Partial<RuleFile> | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    loadRules()
  }, [])

  const globalRules = rules.filter(r => r.scope === 'global')
  const workspaceRules = rules.filter(r => r.scope === 'workspace')

  const handleSelectRule = (rule: RuleFile) => {
    setActiveTabId(rule.path)
    setEditingRule({ ...rule })
  }

  const handleNewRule = (scope: RuleScope, projectId?: string) => {
    setActiveTabId('new')
    setEditingRule({
      scope,
      filename: '',
      content: '',
      projectId
    })
  }

  const toggleProject = (projectId: string) => {
    const next = new Set(expandedProjects)
    if (next.has(projectId)) {
      next.delete(projectId)
    } else {
      next.add(projectId)
    }
    setExpandedProjects(next)
  }

  const handleSave = async () => {
    if (!editingRule || !editingRule.filename) return
    setIsSaving(true)
    try {
      const success = await saveRule(editingRule as RuleFile)
      if (success) {
        if (activeTabId === 'new') {
          setActiveTabId(null)
          setEditingRule(null)
        }
      }
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!editingRule || !editingRule.path) return
    if (confirm(`确定要删除规则 ${editingRule.filename} 吗？`)) {
      await deleteRule(editingRule.path)
      setActiveTabId(null)
      setEditingRule(null)
    }
  }

  const recentProjects = useWorkspaceStore(s => s.recentProjects)

  // Group workspace rules by projectId
  const workspaceRulesGrouped: Record<string, RuleFile[]> = {}
  workspaceRules.forEach(r => {
    if (r.projectId) {
      if (!workspaceRulesGrouped[r.projectId]) workspaceRulesGrouped[r.projectId] = []
      workspaceRulesGrouped[r.projectId].push(r)
    }
  })

  // Expand all projects by default when loaded
  useEffect(() => {
    if (recentProjects.length > 0 && expandedProjects.size === 0) {
      setExpandedProjects(new Set(recentProjects.map(p => p.id)))
    }
  }, [recentProjects])

  return (
    <Flex className="settings-content-wrapper">
      {/* 左侧 - 规则列表 */}
      <Stack className="settings-provider-sidebar" style={{ width: 280 }}>
        <div className="settings-provider-header">
          <h1 className="settings-provider-title">规则设置</h1>
          <p className="settings-provider-desc">管理全局和项目的 Agent 规则，指导 AI 如何编写代码。</p>
        </div>
        
        <Stack className="settings-provider-list-container" style={{ padding: '0 8px' }}>
          {/* 全局规则 */}
          <Stack gap={1} style={{ marginBottom: 16 }}>
            <div 
              className="project-header" 
              style={{ color: 'var(--accent-primary)' }}
            >
              <IconFolder className="shrink-0" style={{ marginRight: 6, fill: 'currentColor' }} />
              <span className="truncate" style={{ flex: 1 }}>全局规则 (Global)</span>
              <div className="project-actions">
                <button className="project-action-btn" onClick={(e) => { e.stopPropagation(); handleNewRule('global') }} title="添加全局规则">
                  <IconMessagePlus />
                </button>
              </div>
            </div>

            {globalRules.map((r) => (
              <div
                key={r.path}
                className={`rule-item ${activeTabId === r.path ? 'active' : ''}`}
                onClick={() => handleSelectRule(r)}
              >
                <IconMessage className="shrink-0" style={{ marginRight: 8, opacity: 0.7 }}/>
                <span className="truncate">{r.filename}</span>
              </div>
            ))}
          </Stack>

          {/* 项目规则 */}
          <Stack gap={1}>
            {recentProjects.map(proj => {
              const projRules = workspaceRulesGrouped[proj.id] || []
              const isExpanded = expandedProjects.has(proj.id)
              
              return (
                <Stack key={proj.id} gap={1}>
                  <div 
                    className="project-header"
                    onClick={() => toggleProject(proj.id)}
                  >
                    <IconChevron 
                      className="shrink-0" 
                      style={{ 
                        marginRight: 4, 
                        transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s',
                        width: 16, height: 16, opacity: 0.6
                      }} 
                    />
                    <IconFolder className="shrink-0" style={{ marginRight: 6, opacity: 0.8 }} />
                    <span className="truncate" style={{ flex: 1 }}>{proj.name}</span>
                    <div className="project-actions">
                      <button className="project-action-btn" onClick={(e) => { e.stopPropagation(); handleNewRule('workspace', proj.id) }} title="添加项目规则">
                        <IconMessagePlus />
                      </button>
                      <button className="project-action-btn" onClick={(e) => { e.stopPropagation(); }} title="更多">
                        <IconMoreHorizontal />
                      </button>
                    </div>
                  </div>
                  
                  {isExpanded && (
                    <Stack gap={1}>
                      {projRules.map((r) => (
                        <div
                          key={r.path}
                          className={`rule-item ${activeTabId === r.path ? 'active' : ''}`}
                          onClick={() => handleSelectRule(r)}
                        >
                          <IconMessage className="shrink-0" style={{ marginRight: 8, opacity: 0.7 }}/>
                          <span className="truncate">{r.filename}</span>
                        </div>
                      ))}
                      {projRules.length === 0 && (
                        <div style={{ padding: '4px 8px 4px 32px', fontSize: 12, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                          暂无规则
                        </div>
                      )}
                    </Stack>
                  )}
                </Stack>
              )
            })}
          </Stack>
        </Stack>
      </Stack>

      {/* 右侧 - 编辑区 */}
      {editingRule ? (
        <Flex direction="col" className="settings-panel-container" style={{ padding: '24px', flex: 1, overflowY: 'auto' }}>
          <Flex align="center" justify="between" style={{ marginBottom: 20 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>
              {activeTabId === 'new' ? '新建规则' : '编辑规则'}
            </h2>
            <Flex gap={2}>
              {activeTabId !== 'new' && (
                <button 
                  className="btn btn-danger" 
                  onClick={handleDelete}
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <IconTrash /> 删除
                </button>
              )}
              <button 
                className="btn btn-primary" 
                onClick={handleSave} 
                disabled={!editingRule.filename || isSaving}
              >
                {isSaving ? '保存中...' : '保存'}
              </button>
            </Flex>
          </Flex>

          <Stack gap={4}>
            {/* Meta data form */}
            <div className="form-group">
              <label>文件名 (File Name)</label>
              <input 
                type="text" 
                className="input" 
                placeholder="例如: react-style.md"
                value={editingRule.filename || ''}
                onChange={e => setEditingRule({ ...editingRule, filename: e.target.value })}
                disabled={activeTabId !== 'new'} // cannot rename existing files easily via this UI yet
              />
              <span className="help-text">推荐使用 .md 后缀。如果填入 AGENTS.md 或 .clinerules 则会存放在根目录。</span>
            </div>

            <div className="form-group" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <label>规则内容 (Markdown)</label>
              <textarea 
                className="input rules-textarea" 
                placeholder={`---\ndescription: 例如: react-style.md\nglobs: src/**/*.tsx\nalwaysApply: false\n---\n\n# 编写你的规则...`}
                value={editingRule.content || ''}
                onChange={e => setEditingRule({ ...editingRule, content: e.target.value })}
                style={{ flex: 1, minHeight: 300, fontFamily: 'monospace', resize: 'vertical' }}
              />
            </div>
          </Stack>
        </Flex>
      ) : (
        <Flex align="center" justify="center" className="settings-empty-pane">
          请选择左侧的一条规则或新建一条规则
        </Flex>
      )}
    </Flex>
  )
}
